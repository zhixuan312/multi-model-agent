---
name: mma-audit
description: Use when the user asks to audit a document, spec, config, or PR description for security, correctness, performance, or style issues — and the audit can run in parallel per file with no context pollution
when_to_use: User asks for a doc/spec/config audit OR a methodology skill (superpowers:dispatching-parallel-agents, /security-review) points at one AND mmagent is running. Delegate so each file audits on its own worker; the main agent only synthesizes findings. Audit on PROSE/SPEC docs — use mma-review for source code.
version: "0.0.0-unreleased"
---

# mma-audit

## Overview

Send a document or set of files to workers for structured auditing. Each file is audited independently in parallel; per-file results are indexed by path in the terminal envelope.

**Core principle:** One worker per file = no cross-file context pollution. The aggregator (you) decides what to do with the findings.

## When to Use

**Use when:**
- A spec / design doc / API contract / config file needs a critical read
- The audit type is `security`, `performance`, `correctness`, or `style` (or a combination)
- 2+ files would benefit from parallel audit

**Don't use when:**
- The thing being audited is source code → `mma-review` (knows about types, call sites, test coverage)
- You want a quick look ("does this look right?") → just `Read` and use your judgment
- The doc references many other files the auditor must cross-reference → consider `mma-review` instead (it pulls in source context)

## Endpoint

`POST /audit?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "document": "inline content to audit (optional if filePaths given)",
  "auditType": "correctness",
  "filePaths": ["/project/docs/spec.md"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `document` | string | no | Inline document content |
| `auditType` | string \| string[] | yes | `security`, `performance`, `correctness`, `style`, or `general`; or an array of the first four |
| `filePaths` | string[] | no | Files to audit (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `document` or `filePaths` (or both) must be provided.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auditType":"correctness","filePaths":["/project/docs/api-spec.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-audit`:

- **Recipe A — Audit-iterate-clean.** `mma-audit` → fix → `mma-audit` again. Sequential rounds. Register the doc via `mma-context-blocks` before round 1 and reuse the same ID across all rounds — avoids re-inlining the same content into every audit call.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel audits on the same document re-flag the same issues without seeing each other's fixes. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Auditing source code with `mma-audit`**
The auditor lacks codebase context (no type info, no call-site lookup, no test awareness). Findings are speculative. **Fix:** use `mma-review` — it pulls in surrounding source context and validates against the actual types.

❌ **Single huge `document` string instead of `filePaths`**
Inline docs lose the file boundary, so the per-file parallel split degenerates to one worker. **Fix:** save to disk first, pass `filePaths`.

❌ **Asking for `auditType: "general"` when you mean something specific**
`"general"` is a catch-all that produces watery findings. **Fix:** pick the dimension you actually care about (`"correctness"` for spec gaps, `"security"` for threat models, etc.).

❌ **Re-auditing the same files round after round without delta context**
Round 2 worker has no idea what round 1 found. **Fix:** register the round 1 findings as a context block (`mma-context-blocks`) and pass `contextBlockIds` to round 2.

@include _shared/error-handling.md
