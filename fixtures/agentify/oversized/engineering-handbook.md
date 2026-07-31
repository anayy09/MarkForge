# Engineering Handbook

The complete conventions set. Too large for a single agent file
by construction: budgeting must push the low-value half into secondary files.

## Rule 1: Imports

Imports are sorted by module path, standard library first. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 2: Exports

Exports are named; a default export is only for a module with one obvious subject. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 3: Line length

Line length is not enforced by a formatter, because reflow destroys diff stability. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 4: Comments

Comments explain why, never what; the code already says what. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 5: Assertions

Assertions carry a message naming the invariant that broke. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 6: Logging

Logging is structured; a log line that cannot be queried is a print statement. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 7: Timeouts

Timeouts are explicit on every outbound call, with no library default relied upon. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 8: Retries

Retries are bounded and jittered; an unbounded retry is an outage amplifier. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 9: Feature flags

Feature flags are removed within two releases of reaching one hundred percent. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 10: Migrations

Migrations are forward-only and reversible by a second migration, never by a rollback. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 11: Secrets

Secrets come from the environment; a secret in a config file is a leaked secret. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 12: Clocks

Clocks are injected, so a test never waits for real time to pass. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 13: Randomness

Randomness is seeded in tests, so a failure reproduces from its output alone. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 14: Fixtures

Fixtures are authored, not captured, so they assert intent rather than behaviour. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 15: Panics

Panics are for programmer error only; operational failure returns an error value. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 16: Public types

Public types are documented at the type, not at each field, unless a field surprises. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 17: Enums

Enums are exhaustively matched; a default arm hides the next variant added. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 18: Nulls

Nulls are absent rather than empty, so a caller cannot confuse the two. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 19: Booleans

Booleans in a signature become an enum once there are two of them. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 20: Constructors

Constructors do no I/O; a type that reads a file on construction cannot be tested. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 21: Interfaces

Interfaces are defined by the consumer, not exported hopefully by the producer. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 22: Generics

Generics are introduced when the second caller appears, never for the first. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 23: Caches

Caches declare an eviction policy at the point they are created. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 24: Metrics

Metrics are named for what they measure, with the unit in the name. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 25: Dashboards

Dashboards are code, reviewed like code. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 26: Alerts

Alerts page a human only when a human must act within the hour. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 27: Runbooks

Runbooks are linked from the alert that needs them. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 28: Postmortems

Postmortems name systems and decisions, never people. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 29: Pull requests

Pull requests under four hundred lines; larger ones are not reviewed, they are skimmed. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.

## Rule 30: Commit messages

Commit messages explain the change in the body, not only in the subject. This rule applies to every service in the platform, and exceptions are recorded in the owning team's decision log rather than negotiated per review.
