# Nimbus Operations Runbook

Maintained by the on-call rotation. Last reviewed 2026-01-14.

## Build

```bash
npm run compile
```

## Environment

```
NIMBUS_BATCH_TIMEOUT_MS=60000
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
```

Sixty seconds gives a large customer batch room to finish. Lowering it caused spurious
retries the last time it was tried.
