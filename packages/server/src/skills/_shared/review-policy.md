### `reviewPolicy` — review lifecycle per task

All task types default to `"reviewed"` (two-phase pipeline: implementer + refiner).
Callers can override per-request, EXCEPT for two types that force a value and ignore the field:

| Type | Forced | Why |
|---|---|---|
| `orchestrate` | `"none"` | The orchestrator's answer IS the deliverable; there is nothing for a second pass to refine. |
| `execute_plan` | `"reviewed"` | Contract satisfaction and `completionPercent` are scored from the reviewer's per-task `tasks[]`, so an unreviewed run has no scoring source at all. |

Sending `reviewPolicy: "none"` to `execute_plan` is accepted and ignored — the reviewer runs and is
billed. This is stated here because the request is silently honoured-looking: nothing in the
response reports that the override was dropped.

For read-only routes (audit, review, debug, investigate, research, journal_recall),
the refiner verifies the implementer's output against source material — checking
citations, evidence accuracy, and completeness. For write routes (delegate,
execute_plan), the refiner also fixes issues directly in the working tree.

| Value | Behavior | Use when |
|---|---|---|
| `"reviewed"` | Two-phase pipeline: implement + review (default) | Default for all types |
| `"none"` | Skip the review stage | Trivially mechanical edits or throwaway scripts where a second-pass reviewer adds nothing |
