# Nimbus Ingest — Service Overview

Nimbus Ingest normalises customer telemetry for the reporting warehouse. It is owned by the
platform team and operated by the on-call rotation.

The queue is the durable boundary: once a batch is enqueued it survives worker restarts, and
nothing is acknowledged to the customer before it is enqueued.
