# Solution design — Method guidance

**Method:** `solution-design@1`
**Purpose:** Define a workable solution for a stated problem.
**Required inputs:** problem statement; goals; constraints
**Expected outputs:** solution design; decision rationale; acceptance criteria

Apply every section below to the design before reporting the work done — a design that reads
well but silently drops a goal or a constraint is not workable.

## Goal coverage

Check the design against every goal named in the problem statement before presenting it, and
confirm each goal is addressed by a specific part of the design, not by a general claim that the
design "handles it." A goal with no corresponding design element is not covered.

## Constraint fit

Validate the design against every stated constraint — technical, resource, timeline, or
organizational — as part of the design review, and identify any point where the design would
violate one. A constraint violation discovered after delivery is a design defect, not an
implementation defect.

## Decision traceability

Record the rationale behind each significant design decision, including the alternatives you
considered and why you rejected them, so a later reader can trace why the design looks the way
it does. A decision with no recorded rationale cannot be safely revisited.
