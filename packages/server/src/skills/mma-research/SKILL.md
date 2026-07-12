---
name: mma-research
description: Use when you need external multi-source research with citations — arxiv, semantic_scholar, github_search, brave-with-site:-filters — for a focused question. Worker is bibliographic, not opinionated. Pair with mma-investigate (internal) under mma-explore for divergent landscape scans.
when_to_use: An external-research question has surfaced (state of the art, prior art, what others do, what published methods exist) AND mma is running. Delegate the multi-source web/adapter research to a worker so the main context stays on judgment. NOT for codebase questions — those are mma-investigate.
version: "0.0.0-unreleased"
---

# mma-research

## Overview

Run external multi-source research via a single mma worker. The worker
consults configured adapters (arxiv, semantic_scholar, github_search) and
— when Brave keys are configured — escalates to Brave web search with `site:`
filters. The worker is bibliographic: it returns a numbered narrative with a
`## Sources used` table. It does not opinion or rank.

**Core principle:** External research is labor (search, fetch, summarise).
Delegate it. The main agent stays on judgment — deciding what the citations
mean and which directions to pursue.

## When to Use

**Use when:**
- "What's the state of the art for X?"
- "Who has published on Y?"
- "What's prior art for Z?"
- The question is external (web, papers, github topics) — not your codebase.

**Don't use when:**
- The question is about THIS codebase → `mma-investigate`
- You need divergent ideation across both internal and external (multiple
  directions with synthesis) → `mma-explore` (orchestrates mma-investigate + mma-research + mma-journal-recall → writes `exploration.md`)
- A single web fetch is all you need → `WebFetch` inline

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Configuration prerequisites

The `mma-research` worker integrates with Semantic Scholar to search academic papers. This adapter is optional but recommended for comprehensive peer-reviewed source coverage.

**Required environment variable:**

```bash
export SEMANTIC_SCHOLAR_API_KEY="your-key-from-semanticscholar.org"
```

Obtain a free API key from [Semantic Scholar API](https://www.semanticscholar.org/product/api).

**Degraded behavior:**

If the Semantic Scholar API key is not configured:
- The worker continues with available adapters (arxiv, github_search, brave-search)
- Semantic Scholar queries are skipped without errors
- Research completes successfully but may lack academic-paper coverage
- No failure occurs; graceful fallback is automatic

## Request body

```json
{
  "type": "research",
  "prompt": "What approaches exist for streaming JSON parsing under 100KB? We currently use a single-pass push parser; we want to evaluate alternatives.",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | 20+ chars — the research question; context can be inline or via contextBlockIds |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) for large background context |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

The research criteria target primary-source preference, practitioner consensus, recency, counter-perspectives, and cross-domain analogues — the worker is bibliographic, not opinionated.

## Full example

```bash
RESULT=$(curl -f -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "research",
    "prompt": "State-of-the-art SIMD JSON parsers under 100KB? We use a single-pass push parser; want SIMD alternatives."
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan / retry) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

## Best practices

- Keep `prompt` topical (keywords, not full sentences).
- For large background context, register it via `mma-context-blocks` and pass `contextBlockIds`.
- For multi-round research, register the previous round's findings via
  `mma-context-blocks` and pass `contextBlockIds`.

## Common pitfalls

❌ **Asking a codebase question here.** External adapters can't grep your repo. **Fix:** use `mma-investigate`.

❌ **Inlining the user's full question verbatim.** Multi-sentence excerpts produce poor adapter queries. **Fix:** the worker re-phrases internally; you just pass the question and let it work.

❌ **Expecting opinionated output.** This worker reports what's out there with citations. Ranking and synthesis happen elsewhere — in `mma-explore` or in your own judgment. **Fix:** if you need ranked options, use `mma-explore`.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** Research that finds nothing is a success — "I searched widely and found nothing." The `output.summary.answer` field contains the narrative; `output.summary.findings` contains individual sources with `url` and `source` fields for citation.

@include _shared/error-handling.md
