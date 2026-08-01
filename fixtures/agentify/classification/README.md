# nimbus-ingest

## Naming

Modules take the name of the thing they do, not the name of the pattern they are built with.

## Errors

An error is either handled where it occurs or allowed to propagate. It is never logged and
swallowed.

## Tests

Every bug fix arrives with the test that would have caught it. A fix without one is a claim.

## Reviews

A pull request that changes behaviour explains why in its description, not only what.

## Dependencies

Adding a runtime dependency needs a written reason. Development dependencies do not.
