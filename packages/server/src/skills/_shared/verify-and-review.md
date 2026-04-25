### `verifyCommand` — local verification after each task

Set when the worker can run a deterministic local check after editing — `npm test`, `npm run lint`, a focused package test. Commands run in order; each must be non-empty after trimming. Output is fed back to the reviewer. Omit when no reliable command exists.

### `reviewPolicy` — review lifecycle per task

| Value | Behavior | Use when |
|---|---|---|
| `"full"` | Spec review + quality review (default) | Default for new code or risky edits |
| `"spec_only"` | Spec review only | Quality review unnecessary (mechanical work) |
| `"diff_only"` | Single-pass review of the produced diff | Cheap mechanical refactors (file moves, renames, import-path updates) |
| `"off"` | Skip review entirely | Trusted low-risk tasks where `verifyCommand` is enough |
