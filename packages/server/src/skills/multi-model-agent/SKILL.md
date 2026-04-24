---
name: multi-model-agent
description: Router for the multi-model-agent local service. Use first when you're about to delegate any tool-using work — picks the right mma-* skill for the task (audit, review, verify, debug, plan execution, ad-hoc delegation) instead of defaulting to inline Agent dispatches.
when_to_use: The user asks for work you'd normally delegate — audit, code review, checklist verification, debugging, plan execution, or ad-hoc parallel tasks — AND mmagent is running. Read this once, pick the matching mma-* skill, and delegate there. Applies equally whether the user invoked a superpowers methodology skill or just asked directly.
version: "0.0.0-unreleased"
---

## multi-model-agent overview

multi-model-agent is a local HTTP service that fans out tool-using work to
sub-agents running on different LLM providers (Claude, OpenAI-compatible, Codex).

### Preflight: auto-start the daemon if it is not running

Before any mma-* call, check the server. If it is not up, start it in the background — do NOT run `mmagent serve` synchronously, it blocks forever.

```bash
PORT=7337
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  mmagent serve >/dev/null 2>&1 &
  disown
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  done
fi
```

Idempotent: already-running daemon → curl succeeds → no-op.

### Auth token

Set the token in your environment:
```bash
export MMAGENT_AUTH_TOKEN=$(mmagent print-token)
```

Or read it from the env var `MMAGENT_AUTH_TOKEN` if already set.
Every request requires `Authorization: Bearer <token>`.

### Skill map

| Skill | Purpose |
|---|---|
| `mma-delegate` | Ad-hoc implementation/research (no plan file) |
| `mma-audit` | Audit a document for security, correctness, style, or performance |
| `mma-review` | Review code for quality, security, or correctness |
| `mma-verify` | Verify work against a checklist |
| `mma-debug` | Debug a failure with a structured hypothesis |
| `mma-execute-plan` | Implement tasks from a plan or spec file |
| `mma-retry` | Re-run specific failed tasks from a previous batch |
| `mma-context-blocks` | Register large reused documents to reference by ID |
| `mma-clarifications` | Confirm or correct the service's proposed interpretation |

### General flow

1. Call the appropriate `mma-*` skill → receive `{ batchId }`.
2. Poll `GET /batch/:id`: `202 text/plain` while pending (body is the running headline), `200 application/json` on terminal.
3. Read `results` / `error` / `proposedInterpretation` from the terminal envelope.

If the terminal envelope has `proposedInterpretation` as a string, use `mma-clarifications` to confirm or correct it.

### Diagnosing slow tasks

Start the server with `mmagent serve --verbose` (or set `diagnostics.verbose: true` in config) to record `tool_call` and `llm_turn` events. Then tail them:

```bash
mmagent logs --follow --batch=$BATCH_ID
```
