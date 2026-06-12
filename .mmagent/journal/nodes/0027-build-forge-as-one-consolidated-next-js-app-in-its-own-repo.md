---
id: "0027"
title: Build Forge as one consolidated Next.js app in its own repo
status: adopted
tags: [forge, architecture, decision, nextjs, repo-boundary]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: relates
    to: "0028"
supersededBy: null
---

## Context

ARCHITECTURE (Forge): build **ONE consolidated Next.js app**, not a split
frontend/backend. The App-Router route handlers **ARE** the backend — the
"server-side brain". There is no separate API service.

Repo boundaries:
- Create exactly **1 git repo** for Forge.
- It is **NOT a monorepo with mma** — there is no shared code; the mma boundary
  is strictly HTTP (see 0028).
- The "multiple repos" Forge appears to manage are **target codebases** that
  users mount into a server workspace directory at runtime. They are user data,
  registered in a `repo` table — NOT repos that we author.

## Consequences

- No shared TypeScript package between Forge and mma; integration is HTTP only.
  Resist the temptation to import mma-core types directly (see 0028).
- Backend logic lives in Next route handlers / server components, not a
  separate service — keep orchestration there.
- The `repo` table models user-mounted target codebases; design authorization
  and workspace handling around them as untrusted user data (see 0033).
