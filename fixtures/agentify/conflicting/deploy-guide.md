# Nimbus Deploy Guide

Maintained by the platform team. Last reviewed 2026-06-02.

## Build

```bash
pnpm build
```

## Environment

```
NIMBUS_BATCH_TIMEOUT_MS=30000
NIMBUS_QUEUE_URL=amqp://queue.internal:5672
```

The timeout was lowered to 30 seconds after the March incident, when long-running batches
held workers open and starved the queue.
