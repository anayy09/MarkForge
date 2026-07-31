# Nimbus Ingest — Product Specification

## Purpose

Nimbus Ingest accepts customer telemetry batches and normalises them for the reporting
warehouse. It replaces the hand-run import scripts retired last quarter.

## Requirements

- No user should ever wait more than two seconds for a batch to be acknowledged.
- A batch that fails validation must be rejected whole. Partial ingestion is never
  acceptable, because a half-loaded batch is indistinguishable downstream from a complete
  one.
- Every rejected batch must be retrievable for thirty days.
- Operators must be able to replay any accepted batch without contacting engineering.

## Out of scope

Schema inference. Customers declare their schema up front, and guessing it was the single
largest source of incidents in the retired scripts.
