### `reviewPolicy` — review lifecycle per task

**Applies to write routes only** (`delegate`, `execute-plan`, `retry`).
Read-only routes (audit, review, debug, investigate, research) do not expose
this field — they are hardcoded to `"none"` because the review stage is
write-routes-only. They still run the always-on **annotate** judge (a
standard-tier LLM pass that summarizes the worker's report); their findings
come from the worker itself, not from a second-pass code review.

| Value | Behavior | Use when |
|---|---|---|
| `"full"` | Spec review + quality review (default) | Default for new code or risky edits |
| `"quality_only"` | Quality review only | Write task where spec-conformance is already certain but you still want a quality pass |
| `"diff_only"` | Single-pass review of the produced diff | Cheap mechanical refactors (file moves, renames, import-path updates) |
| `"none"` | Skip the review stage | Trivially mechanical edits or throwaway scripts where a second-pass reviewer adds nothing |
