# Nimbus Platform

Customer submissions arrive at the edge collector, which writes them to the durable queue and
returns immediately. Nothing downstream is on the acknowledgement path.

Workers read from the queue in batches, validate against the registered schema, and write to
the warehouse in a single transaction. A worker that dies mid-batch leaves the batch on the
queue; the next worker picks it up whole.

The warehouse is the only consumer of committed batches. The rejection store sits beside it
and is written by the workers directly, which is why a rejection survives a warehouse outage.
