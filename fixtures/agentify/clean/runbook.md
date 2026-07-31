# Nimbus Ingest — Operator Runbook

## Deploy

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm deploy --env production
```

## Check health

```bash
curl -sf https://ingest.internal/healthz
```

## Drain the queue before maintenance

```bash
nimbusctl queue drain --wait
```

## Environment

```
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
NIMBUS_BATCH_TIMEOUT_MS=30000
NIMBUS_MAX_BATCH_MB=64
```

## If ingestion stalls

Drain the queue, confirm the warehouse is accepting writes, then restart the workers. Do not
delete queued batches: they are the only copy until the warehouse commit succeeds.
