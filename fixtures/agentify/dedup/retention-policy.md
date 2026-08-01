# Archive Retention Policy

## Scope

This policy covers every artifact the archive service writes to durable storage.

## Rules

Uploads larger than 64 MB must be rejected by the platform.

An operator may raise the ceiling per tenant, but never above 512 MB.

Every archive must be written to two availability zones before the write is acknowledged.

Deletion requests must be honoured within 24 hours.
