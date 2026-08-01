# How we check things

Every change ships with the unit tests for the code it touches. Integration tests cover the
queue boundary and the warehouse write, and nothing else — they are slow and we keep them few.

A flaky test is deleted or fixed within one week of being noticed. We do not retry a flaky
test to make a build green.

Coverage is measured but not enforced by a threshold, because a threshold rewards testing the
easy paths.

Before a release someone runs the replay procedure against staging by hand. That step has
resisted automation twice and we have stopped trying for now.
