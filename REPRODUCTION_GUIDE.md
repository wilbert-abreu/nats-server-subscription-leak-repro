# NATS Subscription Growth Reproduction Guide

This guide demonstrates how to reproduce a subscription accumulation issue observed in production NATS clusters when using JetStream OrderedConsumers with high churn rates.

## Issue Summary

When JetStream `OrderedConsumer` instances with `deliverLastPerSubject()` are rapidly created and destroyed, subscriptions accumulate on cluster nodes that are **not** hosting the stream. This leads to:

- Continuous subscription count growth (~7,000-8,000 subs/minute in testing)
- Memory growth proportional to subscription count
- Stream leader node remains stable; other nodes accumulate

## Architecture

The reproduction environment mirrors a production setup:

```
                    ┌─────────────────────────────────────┐
                    │         CLUSTER A (Hub)             │
                    │  nats-0, nats-1, nats-2, nats-3,    │
                    │            nats-4                    │
                    │         (JetStream enabled)          │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
         ┌─────────┐         ┌─────────┐         ┌─────────┐
         │ leaf-1  │         │ leaf-2  │         │ leaf-3  │
         └─────────┘         └─────────┘         └─────────┘
              │
              ▼
         ┌─────────┐
         │publisher│ (publishes events.>)
         └─────────┘

                    ┌─────────────────────────────────────┐
                    │       CLUSTER B (Gateway)           │
                    │  gw-b-0, gw-b-1, gw-b-2, gw-b-3,   │
                    │            gw-b-4                   │
                    │    (Connected via NATS Gateway)     │
                    └─────────────────────────────────────┘
```

## Prerequisites

- Docker and Docker Compose
- curl
- jq (for JSON parsing)

## Quick Start

### 1. Clone and Start the Environment

```bash
git clone https://github.com/wilbert-abreu/nats-server-subscription-leak-repro.git
cd nats-server-subscription-leak-repro
docker compose up -d --build
```

### 2. Wait for Initialization

Wait ~30 seconds for:
- NATS clusters to form
- JetStream to initialize
- Stream to be created
- Consumers to start churning

### 3. Monitor Subscription Growth

```bash
# Check all Cluster A nodes
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/subsz | jq '{subs: .num_subscriptions, ins: .num_inserts, rem: .num_removes}'
done

# Check all Cluster B nodes
for port in 9222 9223 9224 9225 9226; do
  echo "gw-b-$((port-9222)):"
  curl -s localhost:$port/subsz | jq '{subs: .num_subscriptions, ins: .num_inserts, rem: .num_removes}'
done
```

## Expected Observations

### Initial State (after ~1 minute)

```
nats-0: subs=5,863   ins=9,431   rem=3,568
nats-1: subs=2,236   ins=9,453   rem=7,217   (stream leader - LOW)
nats-2: subs=5,872   ins=9,462   rem=3,590
nats-3: subs=5,871   ins=9,462   rem=3,591
nats-4: subs=5,885   ins=9,488   rem=3,603
```

### After 2 Minutes

```
nats-0: subs=21,049  ins=39,105  rem=18,056
nats-1: subs=2,007   ins=39,123  rem=37,116   (stream leader - STABLE)
nats-2: subs=21,056  ins=39,132  rem=18,076
nats-3: subs=21,051  ins=39,141  rem=18,090
nats-4: subs=21,034  ins=39,141  rem=18,107
```

### Key Metrics to Watch

1. **`num_subscriptions`**: Current subscription count (should be stable, but grows)
2. **`num_inserts`**: Total subscriptions created since startup
3. **`num_removes`**: Total subscriptions removed since startup
4. **`num_subscriptions - (num_inserts - num_removes)`**: Should always be 0 (MISMATCH)

### Stream Leader vs Other Nodes

Check which node hosts the stream (has low subs):

```bash
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/jsz | jq '{streams: .streams, consumers: .consumers}'
  curl -s localhost:$port/subsz | jq '{subs: .num_subscriptions}'
done
```

The node with `streams: 1` is the stream leader and will have low subscription counts. Other nodes accumulate.

## Test Variations

### Stop Consumers to Verify

```bash
# Stop all consumer simulators
docker stop consumer-simulator consumer-simulator-2 consumer-simulator-3 consumer-simulator-gw-1 consumer-simulator-gw-2

# Check - subscriptions should stabilize
curl -s localhost:8222/subsz | jq '{subs: .num_subscriptions}'

# Restart to resume growth
docker start consumer-simulator consumer-simulator-2 consumer-simulator-3 consumer-simulator-gw-1 consumer-simulator-gw-2
```

### Adjust Churn Rate

Edit `docker-compose.yml` environment variables:

```yaml
- CONSUMER_LIFETIME_MS=5000   # How long each consumer lives
- RECONNECT_DELAY_MS=100      # Delay between destroy and recreate
- NUM_CONSUMERS=20            # Number of concurrent consumers per simulator
```

## Consumer Behavior

Each consumer simulator:
1. Creates an `OrderedConsumer` with `deliverLastPerSubject()`
2. Subscribes to wildcard subjects like `events.sensor.station1.>`
3. Waits `CONSUMER_LIFETIME_MS` (default 5 seconds)
4. Calls `subscription.destroy()`
5. Waits `RECONNECT_DELAY_MS` (default 100ms)
6. Repeats

This mimics real-world clients that create ephemeral consumers for real-time data delivery.

## Memory Correlation

Monitor memory alongside subscriptions:

```bash
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/varz | jq '{mem_mb: (.mem/1024/1024|floor), subs: .subscriptions}'
done
```

Memory grows proportionally with subscription count.

## Cleanup

```bash
docker compose down -v
```

## Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Full cluster setup |
| `nats-gw-a.conf` | Cluster A configuration |
| `nats-gw-b.conf` | Cluster B configuration |
| `leaf.conf` | Leaf node configuration |
| `simulator.ts` | Consumer/publisher simulator |
| `Dockerfile.simulator` | Simulator container build |

## NATS Version

Tested with: `nats:2.12.3-alpine`

## Related

- Production observed growth rate: ~9,000 subs/hour
- Simulation growth rate: ~400,000+ subs/hour (~7,500/min with default settings)
