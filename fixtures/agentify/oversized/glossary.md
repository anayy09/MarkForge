# Domain Glossary

**Batch** — one customer submission, validated and committed as a unit.

**Rejection** — a batch that failed validation and was not committed.

**Replay** — re-processing an already-accepted batch without a new submission.

**Drain** — letting the queue empty without accepting new work.

**Warehouse** — the downstream reporting store; the only consumer of committed batches.

**Schema** — the customer-declared shape of a batch, registered before first use.

**Acknowledgement** — the response confirming a batch is durably enqueued.

**Worker** — the process that validates and commits a batch.
