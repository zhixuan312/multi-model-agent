# Architecture review — Method guidance

**Method:** `architecture-review@1`
**Purpose:** Assess a system structure against required qualities and constraints.
**Required inputs:** architecture description; quality goals; constraints
**Expected outputs:** review findings; risks; recommendations

Apply every section below to the review before reporting the work done — a review that reads as
authoritative but rests on impression rather than evidence is not a completed review.

## Evidence-backed findings

For every finding, confirm it cites the specific artifact, diagram, or code location that
supports it, not a general impression of the architecture. A finding that cannot point to
concrete evidence is an opinion, not a review result, and must be marked as such or dropped.

## Trade-off analysis

For each recommendation, compare it against at least one realistic alternative and state what
the recommendation gives up to gain what it gains. A recommendation presented with no
acknowledged trade-off has not actually been analyzed.

## Scope coverage

Before closing the review, check it against every quality goal and constraint named in the
request and confirm each one was actually assessed, not silently skipped because it was harder
to evaluate. Record an explicit "not assessed" note for anything you could not cover, rather than
leaving the gap invisible.
