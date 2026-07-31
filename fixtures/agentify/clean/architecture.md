# Architecture Decisions

## ADR-1: Queue-backed ingestion

We accept batches into a durable queue and acknowledge before processing.

**Rationale:** the p95 acknowledgement budget for a single submission is 2000 milliseconds,
and synchronous validation against the warehouse cannot meet it under load.

## ADR-2: Whole-batch atomicity

A submission is committed in one transaction or not at all.

**Rationale:** downstream reporting cannot distinguish a truncated load from a complete one,
so any partial write becomes a silent data error rather than a visible failure.

## ADR-3: Declared schemas only

Customers register a schema before their first submission.

**Rationale:** inference was the dominant incident source in the previous system.
