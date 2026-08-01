# Nimbus Reporting — Overview

## Decision

Nimbus Reporting will present warehouse data to customers through a hosted dashboard rather
than through scheduled email exports.

**Rationale:** customers have asked for self-service access in every quarterly review since
the product launched, and email exports cannot support the filtering they describe.

## Requirements

- A customer must be able to filter any report by date range and by batch status.
- Reports must render within three seconds for a customer with one year of history.
- Every figure shown must be traceable to the batch that produced it.

## Out of scope

Custom report authoring. Customers pick from a fixed set this release.
