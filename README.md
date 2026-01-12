# NATS OrderedConsumer Subscription Leak Reproduction

Reproduces a subscription accumulation issue when using JetStream `OrderedConsumer` with high churn in clustered NATS environments.

## The Issue

When `OrderedConsumer` instances are rapidly created and destroyed:
- **Stream leader node** maintains stable, low subscription counts
- **Follower nodes** accumulate subscriptions continuously (~7,000-8,000/min)
- Memory grows proportionally with subscription count

## Quick Start

```bash
# Start the environment
docker compose up -d --build

# Wait 30 seconds, then monitor subscription growth
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/subsz | jq '{subs: .num_subscriptions}'
done

# Identify stream leader (has low subs)
for port in 8222 8223 8224 8225 8226; do
  echo "nats-$((port-8222)):"
  curl -s localhost:$port/jsz | jq '{streams: .streams, consumers: .consumers}'
done

# Cleanup
docker compose down -v
```

## Architecture

- **Cluster A**: 5-node JetStream cluster (hub)
- **Cluster B**: 5-node cluster connected via gateway
- **Leaf nodes**: 3 nodes publishing events
- **Consumers**: Simulators churning OrderedConsumers every 5 seconds

## Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Full cluster setup |
| `nats-gw-a.conf` | Cluster A configuration |
| `nats-gw-b.conf` | Cluster B configuration |
| `leaf.conf` | Leaf node configuration |
| `simulator.ts` | Consumer/publisher simulator |
| `REPRODUCTION_GUIDE.md` | Detailed reproduction steps |
| `GITHUB_ISSUE.md` | Issue template for NATS team |

## NATS Version

Tested with `nats:2.12.3-alpine`

## Related Issue

See `GITHUB_ISSUE.md` for the full defect report.
