---
id: "0031"
title: Forge stack — all-latest versions as of 2026-06-08
status: adopted
tags: [forge, stack, decision, dependencies]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: relates
    to: "0027"
supersededBy: null
---

## Context

STACK (Forge, all-latest as of 2026-06-08):

- **Next.js 16 LTS** (App Router / RSC) · **React 19.2** · **TypeScript 5.x**
- **Tailwind v4.3** · **shadcn/ui** (+ Radix)
- **TanStack Query 5** · **Zod 4**
- **Drizzle 0.45 stable** (NOT v1 beta) + **PostgreSQL 17**
- **@anthropic-ai/sdk** (`claude-opus-4-8`)
- **react-markdown + remark-gfm** — **NO MDX** (components are runtime
  LLM-drafted markdown, not authored `.mdx` files)
- **Node 24 LTS** (>= 22 is the mma-core floor) · **npm**

Caveats:
- The telemetry app is on **Tailwind v3 + Zod v3**, so snippets won't copy 1:1.
- **Verify the `@anthropic-ai/sdk` `zodOutputFormat` helper works with Zod 4**
  on first use.

## Consequences

- Pin to these versions for the Forge repo (0027); don't copy telemetry-app
  config verbatim (version skew on Tailwind/Zod).
- Zod 4 + Anthropic structured-output helper is an unverified pairing — confirm
  early because the whole Q&A workflow (0029/0030) depends on it.
- Markdown is rendered at runtime from LLM output via react-markdown; do not
  introduce an MDX toolchain.
