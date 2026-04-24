---
name: multi-model-agent
description: Router for the multi-model-agent local service. Use FIRST when you're about to delegate any tool-using work so you pick the right mma-* skill instead of defaulting to inline Agent dispatches or superpowers:subagent-driven-development.
when_to_use: Any time you're about to delegate implementation, research, audit, review, verify, debug, or execute-plan work AND mmagent is running. Read this before reaching for inline Agent calls or superpowers subagent skills — if mma-* applies, prefer it (cheaper workers, independent context, diagnostic log).
version: "0.0.0-unreleased"
---

## multi-model-agent overview

multi-model-agent is a local HTTP service that fans out tool-using work to
sub-agents running on different LLM providers (Claude, OpenAI-compatible, Codex).

### Setup check

```bash
curl -s http://localhost:$PORT/health
# expects: { "ok": true }
```

If this fails, start the server:
```bash
mmagent serve
```

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
