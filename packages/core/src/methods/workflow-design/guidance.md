# Workflow design — Method guidance

**Method:** `workflow-design@1`
**Purpose:** Define an operational workflow that produces a required outcome.
**Required inputs:** desired outcome; actors; constraints
**Expected outputs:** workflow definition; roles; control points

Apply every section below to the workflow before reporting the work done — a workflow defined
only for its success path will fail the first time reality does not cooperate.

## Step completeness

Before publishing the workflow, trace it from its trigger to its desired outcome and confirm
every step needed to get there is present, including handoffs between actors. A workflow that
skips a necessary step and relies on an unstated assumption will fail the first time that
assumption does not hold.

## Role clarity

For each step and each decision point, define exactly which actor is responsible, so no step has
an ambiguous or shared owner. A step with no clearly assigned actor is a step nobody will
reliably perform.

## Failure handling

For each step, identify what happens when it fails — a rejected input, an unavailable actor, a
timed-out dependency — and define the recovery or escalation path for each. A workflow defined
only for its success path is incomplete.
