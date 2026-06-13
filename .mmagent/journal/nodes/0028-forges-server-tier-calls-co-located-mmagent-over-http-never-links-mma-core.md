---
id: "0028"
title: Forge's server tier calls co-located mmagent over HTTP, never links mma-core
category: decision
status: adopted
tags: [forge, architecture, mma-integration, http-boundary, decision]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: relates
    to: "0027"
  - type: relates
    to: "0020"
supersededBy: null
---

## Context

ARCHITECTURE (Forge): `mma-core` is **Node-only** — it spawns codex/git
subprocesses, touches the filesystem, and runs an HTTP listener. Therefore:
- It **CANNOT** run in a browser.
- It **must NOT be linked server-side either** — doing so would duplicate
  `packages/server`'s orchestration inside Forge.

Instead, Forge's server tier calls the **co-located mmagent HTTP API** on
`127.0.0.1:7337`:
- Headers: `Authorization: Bearer <token>`, `X-MMA-Client`, `X-MMA-Main-Model`.
- Async contract: `202 Accepted` → poll `/batch/:id`.

mmagent runs on the **same box** as Forge so it sees the repo workspace on disk
and can investigate/audit against REAL code via `?cwd=<repo path>`.

## Consequences

- The mma boundary is HTTP only (reinforces 0027 — no shared code, single repo).
- Forge talks to mma through the single invocation surface (relates 0020); it is
  an external HTTP client of that surface.
- Co-location is a hard requirement: mma must be able to read the same on-disk
  workspace Forge mounts target repos into, so investigate/audit run against
  real code, not uploads.
- All Forge→mma calls follow the 202-then-poll batch pattern; design the
  MmaClient around async dispatch + polling (see 0033 Foundation slice).
