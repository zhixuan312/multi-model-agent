---
name: review
description: Use when source code needs a quality / security / correctness pass — pre-merge review, post-implementation sanity check, or focused look at a small file set — and the review can run in parallel per file
when_to_use: User asks for a code review or pre-merge check, OR a review workflow (/review, /security-review) points at one, AND mma is running. Delegate so each file reviews on its own worker; the main agent only decides what to merge. Review on SOURCE CODE — use mma:audit for prose specs / configs.
version: "0.0.0-unreleased"
---

# mma:review

## Overview

mma:review is the **pre-merge gate**. Send code files (or a diff) to a worker for structured review against an executability bar: would a maintainer who reads only the verdict and the diff understand which changes are required, why each is required, and where each lives — well enough to apply the fix and re-merge without re-investigating?

Each file is reviewed independently in parallel; results are index-aligned with `target.paths`.

**Core principle:** Reviewer is a different model from the implementer — different training, different blind spots. Cross-model review catches what self-review misses. The reviewer runs against a 10-category failure-mode taxonomy (test gap, cross-file ripple, missing edge case, race, resource leak, backward-compat break, security/performance regression, implicit-contract assumption, pre-existing-bug-vs-new-regression separation) and weighs every change through the security, performance, and correctness lenses.

## When to Use

**Use when:**
- 1+ source code files just changed (post-implementation review)
- Pre-merge sanity check on a focused diff
- Security-sensitive code path (use `prompt: "focus on security"`)
- A specialized review pass (e.g. `prompt: "focus on performance"` on hot-path code)

**Don't use when:**
- The thing being reviewed is prose / spec / config → `mma:audit` (better-suited prompt template)
- You want to know whether a complete branch is mergeable → run `/ultrareview` (multi-model branch review) instead
- The diff is one-line / one-character → reading inline is faster than dispatch

## How to invoke for cross-file ripple detection

The cross-file ripple pass (changed-symbol → broken caller) only fires when the worker can identify what changed. Two patterns:

- **Diff-as-input (preferred for cross-file ripple)**: pass the diff via the `target.inline` field, plus the named files via `target.paths`. The worker treats the diff as the change-set and greps for callers of changed public symbols.
- **Files-only (static review)**: pass only `target.paths`. The worker reviews the files in their current state without a change-set, so cross-file ripple is degenerate. Test gap, missing edge case, race, leak, and security/performance findings still fire.

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "review",
  "prompt": "optional review instruction or focus area",
  "target": { "paths": ["/project/src/auth/login.ts"] },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no | Optional instruction to focus the review (e.g. "focus on security") |
| `target.inline` | string | no | Inline code snippet to review |
| `target.paths` | string[] | no | Files to review |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) — useful for design docs the reviewer should validate against |
| `practice` | `"software"` | no | Selects the retained CODE technique for this dispatch (caller tracing, error paths, security sinks, schema conformance, test adequacy). Set it when code-level technique is required — not merely when the artifact is code: an n8n workflow or Terraform module often needs it, a report or specification does not. Omitted = the deliverable-neutral implementer. The engine NEVER infers it. Inside `/mma:flow`, read the one persisted `routing.practice` value so every stage of a flow routes identically. |

Exactly one of `target.inline` or `target.paths` must be provided (not both).

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "review", "prompt": "focus on security and correctness", "target": { "paths": ["/project/src/auth/login.ts"] } } }
```

## Response shapes

### mma_run — dispatch

Short tasks return the terminal envelope (below) inline, in the tool result. Longer-running
tasks return a handle instead:

```json
{ "taskId": "<uuid>", "type": "<route>", "cwd": "<abs path>" }
```

Use `taskId` to poll with `mma_task_get` / `mma_task_wait`.

### mma_task_get / mma_task_wait — poll

A still-running task returns identity plus progress (`status: "running"`, `phase`, `elapsedMs`,
`runningHeadline`, …) — not the shape below. A terminal task returns the full envelope — these
6 top-level fields:

```json
{
  "task": {
    "taskId": "<uuid>",
    "type": "<route>",
    "subtype": "<subtype or absent>",
    "status": "completed | done_with_concerns | failed"
  },
  "output": {
    "summary": { /* refiner JSON — shape varies by route, see below */ },
    "filesChanged": ["src/foo.ts", "src/bar.ts"],
    "contextBlockId": "<string or null>",
    "reviewerNote": null
  },
  "execution": {
    "sessions": { "implementer": "<session-id>", "reviewer": "<session-id or null>" },
    "worktree": null
  },
  "metrics": {
    "totalDurationMs": 12400,
    "totalCostUsd": 0.08,
    "implementer": { "durationMs": 8000, "costUsd": 0.05, "usage": { "inputTokens": 1200, "outputTokens": 800, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } },
    "reviewer":     { "durationMs": 4000, "costUsd": 0.03, "usage": { "inputTokens": 900, "outputTokens": 400, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } }
  },
  "raw": {
    "implementer": "<raw text output>",
    "reviewer": "<raw text output or null>"
  },
  "error": null
}
```

### How to read the envelope

**Step 1 — check `error`:**

| Shape | Meaning |
|---|---|
| `error` is `null` | Task succeeded — read `output` |
| `error` is `{ "code": "...", "message": "..." }` | Task failed — read `error.code` + `error.message` |

**Step 2 — extract the result from `output.summary`:**

`output.summary` is the **parsed JSON** from the refiner (reviewer). Its internal shape varies by route — see the per-skill "Reading the output" section for the exact fields. Common patterns:

| Route family | What `output.summary` contains |
|---|---|
| Read routes (audit, review, investigate, debug, research) | `{ findings: [...], criteriaCovered: [...], ... }` — findings array is the main payload |
| Write routes (delegate, execute_plan) | `{ status: 'done'\|'failed', notes }` or `{ tasks: [...], notes }` |
| Spec / Plan | `{ specPath, sections, acceptanceCriteriaCount, notes }` or `{ planPath, taskCount, tasks, notes }` |
| Journal recall | `{ answer, criteriaCovered, findings: [{ weight, category, claim, evidence, topic, fallback, nodeId, nodePath }] }` |
| Journal record | `{ recorded: [...], failed: [...] }` |

**Step 3 — for read routes, extract findings:**

```
response.output.summary.findings   ← the findings array
response.output.summary.findings[i].weight      ← "critical" | "high" | "medium" | "low"
response.output.summary.findings[i].category
response.output.summary.findings[i].claim       ← one-sentence summary
response.output.summary.findings[i].evidence    ← grounding text
response.output.summary.findings[i].suggestion  ← fix recommendation (some routes omit this)
```

**Step 4 — for write routes, read files changed:**

```
response.output.filesChanged       ← array of relative paths modified by the worker
response.output.contextBlockId     ← non-null for read routes (reusable in contextBlockIds)
```

**Step 5 — check `output.reviewerNote` (reviewer availability):**

`output.reviewerNote` is `null` on the normal path. When the reviewer ran but its output
couldn't be parsed, the task degrades to `status: "done_with_concerns"` with **`error: null`**
(a reviewer format flake is a concern, not a failure), and `output.summary` falls back to the
**implementer's** answer. `reviewerNote` then carries the reason:

```json
"reviewerNote": { "code": "reviewer_unavailable", "message": "<why the parse failed>" }
```

Treat a non-null `reviewerNote` as advisory: the answer in `output.summary` is the un-refined
implementer output, still usable. Never discard the task on `reviewerNote` alone.

### Common extraction mistakes

❌ **Reading `output.findings`** — this field does NOT exist. Findings are inside `output.summary.findings`.

❌ **Reading `results` or `structuredReport`** — these are legacy field names from older API versions. The current envelope uses `output.summary`.

❌ **Treating `output.summary` as a string** — it is parsed JSON (an object), not a string. If it looks like a string, the underlying output could not be parsed at all — check `output.reviewerNote` and, as a last resort, `raw.implementer`.

❌ **Ignoring `error: null` check** — a `status: "done_with_concerns"` task has `error: null` and is a success (advisory concerns only). Only `error !== null` is a failure. In particular, when a reviewer emits non-JSON, the task is `done_with_concerns` with `error: null`, `output.summary` holds the implementer answer, and `output.reviewerNote` explains the degrade — do NOT treat this as a failure.

### Tool call error

A malformed or unresolvable call (bad `cwd`, unknown `taskId`, failed admission) surfaces as an
MCP tool error rather than a terminal envelope — the tool result carries `isError: true` and this
payload:

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

This is a different signal than Step 1 above: it means the call itself could not be admitted or
resolved, not that a dispatched task ran and failed. A dispatched task's failure always shows up
in the terminal envelope's `error` field instead.


## Reading the findings

The main agent reads findings from the terminal envelope at `output.summary.findings` (NOT `output.findings` — that field does not exist). `output.summary` is the parsed refiner JSON; findings are nested inside it. Read-only routes like `mma:review` do not produce commits — `execution.worktree` is always `null`.

### Finding shape

Every finding in `output.summary.findings` has this shape:

| Field | Type | Notes |
|---|---|---|
| `weight` | `'critical' \| 'high' \| 'medium' \| 'low'` | Severity tier. |
| `category` | string | Topical bucket, e.g. `test-gap`, `cross-file-ripple`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string | Verbatim from source when grounded. |
| `file` | string | File path where the finding was observed. |
| `line` | number | Line number in the file. |
| `suggestion` | string | Fix recommendation. |
| `preExisting` | boolean | `true` if the issue predates the change under review. |

### Recommended rendering by the main agent

1. Show ALL findings — never silently drop. Weight and grounding are soft
   signals, not gates.
2. Default sort: weight (critical → low).
3. `weight` is the authoritative severity — use it directly.
4. Mark findings with `evidence` shorter than 30 chars as "low-evidence"
   (lighter color or `(low evidence)` annotation). User decides what to do.
5. Weight-tier counts feed the dashboard.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma:review`:

- **Recipe A (analog) — Review-iterate-clean.** `mma:review` → fix → `mma:review` again. Same shape as the audit recipe, applied to source code. Sequential rounds; register the file(s) via `mma:context-blocks` before round 1 and reuse the same ID across rounds.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel reviews of the same source file re-flag the same issues. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Reviewing a plan/spec markdown with `mma:review`**
The reviewer is tuned for code constructs (types, call sites, test coverage). On prose it produces vague nits. **Fix:** use `mma:audit` for docs/specs, `mma:review` for source.

❌ **Omitting a focus direction and getting watery findings**
A general review surfaces low-signal style nits alongside real bugs. **Fix:** use `prompt` to bias the reviewer toward the dimension you care about (e.g. `"focus on correctness"` or `"focus on security"`).

❌ **Inlining the spec the reviewer should validate against**
If the reviewer needs to check the diff against a design doc, register the doc once via `mma:context-blocks` and pass the `contextBlockIds`. Inlining N times wastes tokens.

❌ **Skipping review because "I already read it"**
Self-review and cross-model review are not the same thing. The whole reason to delegate is the different blind spots. Read the findings; merge what you agree with.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Pass round-N review findings to round N+1 via `contextBlockIds`
- Feed review results into a downstream `mma:delegate` fix step
- Accumulate findings across iterative review rounds

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** A review with zero findings is a success — the code passed inspection. Check `output.summary.findings.length === 0`.

## Acceptance-criteria review (B6 in a disposition-driven mma:flow)

When invoked as B6 of `mma:flow`'s caller-owned flow (see `mma:flow/SKILL.md` → Common:
Acceptance closure), mma:review is the ONLY producer of `agent-review` acceptance evidence: for
every acceptance criterion on the approved contract whose `method` is `agent-review`, the
reviewer's verdict is a `passed` / `failed` outcome the caller persists as that criterion's
`VerificationRecord` in `.mma/verifications/<stem>.json`, bound to the exact output reviewed
(`subjectDigest`). A `command` outcome from B7 is never substituted with an `agent-review`
verdict from here, and vice versa — the two methods stay distinct evidence, never interchanged.
