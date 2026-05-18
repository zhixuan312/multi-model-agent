### `reviewPolicy` — review lifecycle per task

| Value | Behavior | Use when |
|---|---|---|
| `"full"` | Spec review + quality review (default) | Default for new code or risky edits |
| `"quality_only"` | Quality review only | Read-only audit/review/debug/investigate routes |
| `"diff_only"` | Single-pass review of the produced diff | Cheap mechanical refactors (file moves, renames, import-path updates) |
| `"none"` | Skip review entirely | Skip review entirely. Use when the worker's output needs no second-pass quality check (e.g., trivially mechanical edits, throwaway scripts). |
