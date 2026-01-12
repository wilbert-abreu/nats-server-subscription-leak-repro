# Subscription accumulation with OrderedConsumer churn in clustered environment

## Observed behavior

When JetStream `OrderedConsumer` instances are rapidly created and destroyed in a clustered NATS environment, subscriptions accumulate on follower nodes. The subscription count grows continuously even though consumers are properly destroyed via `subscription.destroy()`.

**Key observations:**
- Stream leader maintains **stable, low** subscription counts
- All other cluster nodes accumulate subscriptions at ~7,000-8,000 per minute
- Gateway-connected clusters remain stable
- When consumer churn stops, subscription count stabilizes (no further growth)
- `num_subscriptions` always equals `num_inserts - num_removes` (no accounting mismatch)

**Sample metrics after 2 minutes of running:**

```
nats-0: subs=21,049  ins=39,105  rem=18,056   (accumulating)
nats-1: subs=2,007   ins=39,123  rem=37,116   (stream leader - stable)
nats-2: subs=21,056  ins=39,132  rem=18,076   (accumulating)
nats-3: subs=21,051  ins=39,141  rem=18,090   (accumulating)
nats-4: subs=21,034  ins=39,141  rem=18,107   (accumulating)
```

**After 10 minutes:**

```
nats-0: subs=67,784  (accumulating)
nats-1: subs=1,626   (stream leader - still stable)
nats-2: subs=67,790  (accumulating)
nats-3: subs=67,796  (accumulating)
nats-4: subs=67,799  (accumulating)
```

This leads to memory growth proportional to subscription count, requiring periodic pod restarts in production.

## Expected behavior

Subscription count should remain stable over time when OrderedConsumers are being created and destroyed at a steady rate. After `subscription.destroy()` is called, the internal subscriptions created by OrderedConsumer should be fully cleaned up on **all** cluster nodes, not just the stream leader.

## Server and client version

- **NATS Server**: 2.12.3 (`nats:2.12.3-alpine` Docker image)
- **NATS.js Client**: 2.x (using `nats` npm package)

## Host environment

- Docker containers using `nats:2.12.3-alpine`
- 5-node NATS cluster (cluster-a) with JetStream enabled
- 5-node NATS cluster (cluster-b) connected via gateway
- 3 leaf nodes connecting to cluster-a
- Host: macOS / Linux

## Steps to reproduce

### 1. Clone and start the reproduction environment

```bash
git clone [repo]
cd scripts/subscription-leak-repro
docker compose up -d --build
```

### 2. Wait ~30 seconds for initialization

The environment creates:
- 5-node JetStream cluster (cluster-a)
- 5-node gateway cluster (cluster-b)
- 3 leaf nodes
- A stream named `events` with subjects `events.>`
- Consumer simulators that churn OrderedConsumers

### 3. Monitor subscription growth

```bash
# Check subscription counts across all nodes
for port in 8222 8223 8224 8225 8226; do
  curl -s localhost:$port/subsz | jq "{node: \"nats-$((port-8222))\", subs: .num_subscriptions}"
done
```

### 4. Identify stream leader (has low subs)

```bash
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/jsz | jq '{streams: .streams, consumers: .consumers}'
done
```

The node with `streams: 1` is the stream leader and will have low subscription counts.

### 5. Verify it's the consumer churn causing growth

```bash
# Stop consumers - subscriptions should stabilize
docker stop consumer-simulator consumer-simulator-2 consumer-simulator-3

# Check - no more growth
curl -s localhost:8222/subsz | jq '.num_subscriptions'

# Restart - growth resumes
docker start consumer-simulator consumer-simulator-2 consumer-simulator-3
```

### Stream info

```
Name: events
Subjects: events.>
Retention: Limits
Replicas: 1
Storage: File
```

### Consumer info

OrderedConsumers created with:
```typescript
const opts = consumerOpts();
opts.orderedConsumer();
opts.deliverLastPerSubject();

const sub = await js.subscribe("events.sensor.>", opts);
// ... consume for 5 seconds ...
await sub.destroy();
// ... wait 100ms, repeat ...
```

### Consumer churn pattern

- Consumer lifetime: 5 seconds
- Reconnect delay: 100ms
- Concurrent consumers per simulator: 10-20
- Total simulators: 5

## Additional context

**Production impact:**
- ~9,000 subscription growth per hour on non-leader nodes
- Memory growth of ~500MB over 24 hours
- Requires periodic pod restarts to reclaim memory

**Workarounds attempted:**
1. Increasing consumer lifetime reduces growth rate but doesn't eliminate it
2. Using durable consumers instead of OrderedConsumer avoids the issue
3. Periodic NATS pod restarts as operational mitigation

**Questions:**
1. Is there a known issue with OrderedConsumer subscription cleanup in clustered environments?
2. Why do non-stream-leader nodes accumulate subscriptions while the stream leader remains stable?
3. Are there server-side configuration options that might help?
