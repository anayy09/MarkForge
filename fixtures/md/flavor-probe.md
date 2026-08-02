---
title: Flavour probe
status: draft
---

# Retention Policy

A batch that fails validation must be rejected whole[^1].

> [!NOTE]
>
> Sealed records are retained for the statutory period.

| Field       | Type      | Required |
| ----------- | --------- | -------- |
| `reference` | string    | yes      |
| `sealedAt`  | timestamp | yes      |

The acknowledgement budget is $t_{ack} = d / r$ under sustained load.

$$
T = \max(T_{statutory}, T_{appeal})
$$

Operators may extend the window **once**, by _written request_.

[^1]: Partial ingestion is never acceptable.
