---
name: mma-orchestrate
description: Use when a frontend workflow needs a high-quality LLM brain for orchestration — send a structured prompt, get a structured response, reuse the session across workflow phases
when_to_use: A multi-phase workflow (explore → spec → plan → execute) needs an intelligent orchestrator that maintains session context across phases. Each call sends a self-contained prompt; the agent processes it and returns structured output the calling system parses directly.
version: "0.0.0-unreleased"
---

# mma-orchestrate

## Overview

The orchestrate endpoint provides a session-persistent, high-quality LLM agent for multi-phase workflow orchestration. Unlike worker routes (audit, delegate, review), the orchestrate agent has no reviewer, no commit, and no findings structure — it takes a prompt and returns the output the caller needs.

**Core principle:** The frontend owns the workflow state; MMA provides the LLM continuity. Each prompt is self-contained; session reuse provides project context across phases.

## When to Use

**Use when:**
- A multi-step workflow needs an intelligent brain across phases
- The calling system constructs structured prompts and expects structured responses
- Session continuity across workflow phases improves output quality
- The task requires synthesis, analysis, or decision-making — not file writing

**Don't use when:**
- You need file modifications → use `mma-delegate`
- You need structured code review → use `mma-review`
- You need document auditing → use `mma-audit`
- A single API call suffices — orchestrate is for when you need tool use + reasoning

## Dispatch

Call the `mma_run` MCP tool with `cwd` and this `request` body. If the `mma_run` MCP tool is not
available in this session, run `mma clients`.

```json
{
  "cwd": "/project",
  "request": {
    "type": "orchestrate",
    "prompt": "Synthesize the exploration results into a requirements specification...",
    "outputFormat": "json"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"orchestrate"` | yes | Discriminator |
| `prompt` | string | yes | The full instruction for this workflow phase |
| `outputFormat` | string | no | Hint for desired output format (e.g. `"json"`, `"markdown"`) |
| `sessionIds` | object | no | `{ implementer: "<session-id>" }` — reuse a prior session |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) |

> Worker tier defaults to `main` — the model driving mma. `agents.main` is required in the config and the daemon refuses to start without it, so there is no substitution to another tier. Send `agentTier` to run on `standard` or `complex` instead. Review is always skipped — there is no reviewer phase.

## Session Reuse

To maintain context across workflow phases, capture the session ID from the first response and pass it back:

```json
// Phase 1: Exploration
{ "cwd": "/project", "request": { "type": "orchestrate", "prompt": "Explore the codebase for auth patterns..." } }
// -> read execution.sessions.implementer from the terminal envelope as sessionId

// Phase 2: Specification (reuse session)
{ "cwd": "/project", "request": { "type": "orchestrate", "prompt": "Based on your exploration, write a spec...", "sessionIds": { "implementer": "<sessionId from phase 1>" } } }
```

@include _shared/response-shape.md
