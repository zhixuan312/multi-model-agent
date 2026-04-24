---
name: multi-model-agent
description: Overview of the multi-model-agent local service. Use this skill to understand which specialized mma-* skill to invoke for a given task.
when_to_use: When the user asks about delegating tool-using work, or when auth/setup issues arise before a specific mma-* skill can run.
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
2. Poll `GET /batch/:id` until `state` is terminal.
3. Read `results` from the completed batch.

If the batch reaches `awaiting_clarification`, use `mma-clarifications`
to confirm or correct the proposed interpretation before the batch resumes.
