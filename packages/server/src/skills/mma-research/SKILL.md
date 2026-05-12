---
name: mma-research
description: Use when you need external multi-source research with citations — arxiv, semantic_scholar, github_search, rss, brave-with-site:-filters — for a focused question. Worker is bibliographic, not opinionated. Pair with mma-investigate (internal) under mma-explore for divergent landscape scans.
when_to_use: An external-research question has surfaced (state of the art, prior art, what others do, what published methods exist) AND mmagent is running. Delegate the multi-source web/adapter research to a worker so the main context stays on judgment. NOT for codebase questions — those are mma-investigate.
version: "0.0.0-unreleased"
---

# mma-research

## Overview

Run external multi-source research via a single mmagent worker. The worker
consults configured adapters (arxiv, semantic_scholar, github_search, rss) and
— when Brave keys are configured — escalates to `web_search` with `site:`
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
  directions with synthesis) → `mma-explore` (orchestrates mma-investigate + mma-research)
- A single web fetch is all you need → `WebFetch` inline

## Endpoint

`POST /research?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "researchQuestion": "What approaches exist for streaming JSON parsing under 100KB?",
  "background": "We currently use a single-pass push parser; we want to evaluate alternatives.",
  "subtype": "default",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `researchQuestion` | string | yes | 20–8000 chars |
| `background` | string | yes | 20–8000 chars; what you already know / are trying to do |
| `subtype` | `'default'` | no (defaults to `'default'`) | Reserved for future criteria sets; only `default` is wired today. |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

> Worker tier is hardcoded `complex`. Sending `agentType` or `tools` is rejected with HTTP 400.

The `default` subtype's criteria target primary-source preference, practitioner consensus, recency, counter-perspectives, and cross-domain analogues — the worker is bibliographic, not opinionated.

## Full example

```bash
BATCH=$(curl -f -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Content-Type: application/json" \
  -d '{
    "researchQuestion": "State-of-the-art SIMD JSON parsers under 100KB?",
    "background": "We use a single-pass push parser; want SIMD alternatives."
  }' \
  "http://localhost:$PORT/research?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Per-task report shape

```
results[0].structuredReport.findings[]    // numbered findings with citations
results[0].structuredReport.sourcesUsed[] // table of sources tried
results[0].output                          // raw narrative report
```

## Best practices

- Keep `researchQuestion` topical (keywords, not full sentences).
- Use `background` to give the worker context that helps it phrase queries.
- For multi-round research, register the previous round's findings via
  `mma-context-blocks` and pass `contextBlockIds`.

## Common pitfalls

❌ **Asking a codebase question here.** External adapters can't grep your repo. **Fix:** use `mma-investigate`.

❌ **Inlining the user's full question verbatim.** Multi-sentence excerpts produce poor adapter queries. **Fix:** the worker re-phrases internally; you just pass the question and let it work.

❌ **Expecting opinionated output.** This worker reports what's out there with citations. Ranking and synthesis happen elsewhere — in `mma-explore` or in your own judgment. **Fix:** if you need ranked options, use `mma-explore`.

@include _shared/error-handling.md
