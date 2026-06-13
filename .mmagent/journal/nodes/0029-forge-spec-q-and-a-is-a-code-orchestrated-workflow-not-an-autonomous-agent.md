---
id: "0029"
title: Forge spec Q&A is a code-orchestrated workflow, not an autonomous agent
category: decision
status: adopted
tags: [forge, architecture, decision, workflow, structured-outputs, mma-integration]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

KEY DECISION (Forge): the per-component spec Q&A is a **WORKFLOW** — a
code-orchestrated loop — **NOT** an Agent-SDK / Managed-Agents autonomous agent.

- Each step is **one Claude Messages API call** (`claude-opus-4-8`, adaptive
  thinking) using **structured outputs** (`output_config.format` /
  `messages.parse`).
- Distinguish the **"agent loop"** (hand-rollable in ~40 lines) from the
  **"Agent SDK"** (a hosted harness). Forge needs **neither** autonomous option
  for Q&A; the **wizard state machine owns the loop**.

Agentic autonomy only enters the **Build phase**, and even there Forge merely
**CALLS mma rods over HTTP** — the mma rods ARE the agents (see 0028).

## Consequences

- The Q&A control flow is deterministic application code, not an autonomous
  agent; state lives in the wizard/state machine (and Postgres, see 0032).
- Use Anthropic structured outputs for each turn's machine-readable result
  (the satisfaction signal, see 0030). Verify the `@anthropic-ai/sdk`
  `zodOutputFormat` helper works with Zod 4 on first use (see 0031).
- Do not reach for the Agent SDK / Managed Agents for Forge — autonomy is
  confined to the Build phase and delegated to mma rods.
