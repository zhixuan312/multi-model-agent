---
name: audit
description: Use when the user asks to audit a spec / plan / design doc / skill file. The `subtype` field picks the criteria set. `default` (prose-coherence) is the general doc auditor. `plan` verifies a code-execution plan against the actual codebase — run this before any `mma:execute-plan` dispatch. `spec` audits requirement prose for testability and decision-trace. `skill` audits a SKILL.md against reader-effectiveness criteria.
when_to_use: User asks for a doc / spec / plan / skill audit OR a review workflow (e.g. /security-review) points at one AND mma is running. Audit on PROSE/SPEC docs — use mma:review for source code. Audit a CODE-EXECUTION PLAN against the codebase — use subtype=plan.
version: "0.0.0-unreleased"
---

# mma:audit

## Overview

`mma:audit` sends a prose artifact to workers for structured auditing. The `subtype` field picks WHICH criteria set the workers apply — every subtype runs through the same sequential-criteria read-only lifecycle, but each one carries its own criteria list, semantics, and prompt scaffolding.

**Four subtypes — picked by the kind of artifact, not by the lens you want:**

| You're auditing… | Use… | What it checks |
|---|---|---|
| A general prose artifact (design doc, recommendation, post-mortem, README) | `subtype: 'default'` | Comprehensive prose-coherence — would a literal-following worker produce the right outcome from this prose alone? Catches ambiguity, contradictions, missing branches, drift, scope-creep. **Does NOT verify against any codebase.** |
| A **code-execution PLAN** (`.mma/plans/*.md` or similar) before running it via `mma:execute-plan` | `subtype: 'plan'` | Plan-vs-codebase coherence — for every method / type / file path / signature / import / verify command the plan names, the codebase actually contains it as described. Catches the bug class the prose-coherence audit cannot see (e.g. plan says `registerBlock` but actual interface is `register`). |
| A **requirement spec** (what we want, why; success criteria) | `subtype: 'spec'` | Requirement-prose executability across 9 criteria — testability, scope explicitness AND decomposability, acceptance-criteria coverage, non-functional capture, requirement conflicts, decision-trace, assumption exposure, placeholder scan, and design-decomposition presence (architecture / components / data flow / error handling / testing). |
| A **SKILL.md** for an `mma:*` skill or comparable agent-facing playbook | `subtype: 'skill'` | Skill-file reader-effectiveness — when-to-use specificity, endpoint contract integrity, example correctness, anti-pattern coverage, link integrity. |

If you want to bias workers toward a narrow lens (security only, performance only, accessibility only), put that in the free-text `background` portion of the prompt — `subtype` is criteria machinery, not a lens selector.

## When to Use

- `subtype: 'default'` — a general prose artifact needs a critical read for internal executability (the artifact will be acted on by a worker reading the prose alone).
- `subtype: 'plan'` — you have a written code-execution plan on disk and you're about to dispatch tasks from it via `mma:execute-plan`. This is the ONLY subtype that grounds findings against real source files.
- `subtype: 'spec'` — you have a requirement / brainstorming-output spec and want to verify every requirement is testable, traceable, and unambiguous BEFORE writing the plan. Typical predecessor to `writing-plans`.
- `subtype: 'skill'` — you're authoring or revising an `mma:*` skill or comparable SKILL.md and want to know whether agents will actually read it the right way.

**Don't use mma:audit when:** the thing being audited is source code (→ `mma:review`); a 30-second `Read` would answer it; or you want to verify a plan that hasn't been written yet (write the plan first).

## Endpoint

`POST /task?cwd=<abs-path>`

## Prefer the MCP tools when they are available

**Before using the HTTP/curl route below, check whether the `mma_run` MCP tool is available in
this session. If it is, USE IT INSTEAD.** The curl route documented here is the fallback for
sessions with no MCP connection.

```
mma_run({ cwd: "<abs-path>", mode: "handle", request: { type: "<task type>", ... } })
```

The request body is identical — the same `type`, `prompt`, `target`, and options described
below ride inside `request`. Poll with `mma_task_get`, block with `mma_task_wait`, stop with
`mma_task_cancel`, instead of the curl polling loop.

Why this matters, so the choice is not arbitrary:

- **Hosts that support MCP Apps render a live execution monitor** for `mma_run` — phase and
  elapsed time update in place, with a working Cancel button, and none of it costs an extra
  model turn. The curl route cannot produce that: the host has no idea a task is running, so
  progress can only be surfaced by the agent polling and re-reporting, which costs a turn each
  time. Going through curl on such a host silently gives up the better experience.
- **No token handling.** The MCP route is already authenticated; the curl route needs
  `mma print-token` and a bearer header, which is one more place a credential can leak into a
  transcript or a shell history.
- **Errors arrive structured** rather than as an HTTP body to parse.

Use the curl route when `mma_run` is genuinely absent — a bare terminal, a CI job, or a client
with no MCP support. Do not use it merely because this document spells the HTTP call out in
more detail.


## Authentication & identity headers

Every request to the multi-model-agent server requires:

| Header | Required for | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | All routes (except `/health`) | Auth — token from `mma print-token` |
| `X-MMA-Client: <client>` | All tool routes | Identifies your client. One of `claude-code`, `cursor`, `codex-cli`, `gemini-cli`. **Server returns `400 client_required` if missing.** |
| `X-MMA-Main-Model: <model-id>` | All tool routes | Calling agent's model id (e.g. `claude-opus-4-7`, `gpt-5.4`). Used as `mainModel` in wire telemetry so cost-delta-vs-main and family attribution can be computed. **Server returns `400 main_model_required` if missing.** Auto-detection is intentionally not attempted — the calling client is the only reliable source. |

### Obtain the token

**From environment variable** (preferred):
```
MMA_AUTH_TOKEN=<token>
```

**From CLI**:
```bash
mma print-token
```

### Shell helper

```bash
TOKEN="${MMA_AUTH_TOKEN:-$(mma print-token)}"
MMA_CLIENT="${MMA_CLIENT:-claude-code}"
MMA_MAIN_MODEL="${MMA_MAIN_MODEL:-claude-opus-4-7}"

curl \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  ...
```

### Errors

- `401 unauthorized` — verify the token matches `~/.mma/auth-token`. The token persists across restarts; it only changes if the file is manually deleted.
- `400 client_required` — `X-MMA-Client` header is missing on a tool route. Set it to one of: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`.
- `400 main_model_required` — `X-MMA-Main-Model` header is missing on a tool route. Set it to the calling agent's model id (e.g. `claude-opus-4-7`, `gpt-5.4`).


## Request body

```json
{
  "type": "audit",
  "prompt": "optional audit instruction",
  "subtype": "default",
  "target": { "paths": ["/project/.mma/specs/2026-07-11-feature-design.md"] },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `target.inline` | string | no | Inline document content |
| `subtype` | `'default' \| 'plan' \| 'spec' \| 'skill'` | no (defaults to `'default'`) | See "Picking subtype" below. |
| `target.paths` | string[] | no | Files to audit (one audit per dispatch) |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) |

Exactly one of `target.inline` or `target.paths` must be provided (not both).

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Picking subtype

| Value | When to use |
|---|---|
| `default` (or omit the field) | **General prose — design doc, recommendation, post-mortem, README, brief.** Comprehensive prose-coherence audit. Does NOT verify against any codebase. |
| `plan` | **Code-execution plans being audited against a real codebase.** Single-file input (the plan markdown). Workers grep / read source files under `cwd` to verify every named symbol / path / signature / import / verify command. Use this BEFORE every `mma:execute-plan` dispatch. |
| `spec` | **Requirement spec / brainstorming-output / what-we-want prose.** 9 criteria target testability, scope explicitness + decomposability, acceptance-criteria coverage, non-functional capture, requirement conflicts, decision-trace, assumption exposure, placeholder scan, and design-decomposition presence. |
| `skill` | **`SKILL.md` or comparable agent-facing playbook.** Criteria target when-to-use specificity, endpoint contract integrity, example correctness, anti-pattern coverage, link integrity. |

You can run BOTH on a plan: first `spec` or `default` (prose quality), then `plan` (does the plan match the codebase?). They cover orthogonal failure modes.

The legacy `auditType` field and its `correctness` / `style` / `general` / `security` / `performance` values no longer exist. Sending `auditType` returns `400 invalid_request`. Sending unknown `subtype` values returns `400 invalid_request` with the allowed enum.

### Plan-audit specifics

When `subtype: 'plan'`:

- **`cwd` = the target repo** (the codebase the plan will be executed against). **`target.paths` = the plan file** (which may live outside the target repo, e.g. `.mma/plans/2026-01-15-<slug>.md`). The worker greps and reads source files under `cwd` to verify the plan's claims. If `cwd` points at the wrong directory, the worker searches the wrong codebase and produces false findings.
- `target.paths` MUST contain exactly **one entry** — the plan markdown. Sending zero or 2+ entries → `400 invalid_request` with the message: *"Plan audit takes exactly one filePath (the plan markdown). The worker discovers and verifies source files itself via its tool surface — do not pre-list source files."*
- `target.inline` (inline content) is not used in plan mode — the plan must be on disk so the worker can read it.
- The worker runs the sequential-criteria loop with the plan-audit criteria set across 12 perspectives in three groups: **EXTERNAL CODEBASE COHERENCE** (1 PATH EXISTENCE, 2 SYMBOL EXISTENCE, 3 SIGNATURE MATCH, 4 IMPORT GRAPH, 5 TEST HARNESS AVAILABILITY, 6 STEP SEQUENCE WITHIN TASK, 7 CROSS-TASK DEPENDENCIES, 8 VERIFICATION COMMAND VALIDITY), **INTRA-PLAN STRUCTURE** (9 TASK GRANULARITY, 11 PLACEHOLDER LANGUAGE, 12 PLAN SKELETON), and **SPEC ALIGNMENT** (10 SPEC COVERAGE).
- To enable perspective 10 (SPEC COVERAGE), register the upstream spec as a context block via `mma:context-blocks` and pass its `blockId` in `contextBlockIds`. Without a spec in context, perspective 10 emits "No findings for this criterion." and the other 11 still run.
- Read the findings list. Fix the plan and re-audit if any `critical` or `high` plan-audit findings remain.

## Full example

### Default audit (general prose)

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"audit","subtype":"default","target":{"paths":["/project/.mma/specs/2026-07-11-api-design.md"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

### Spec audit (requirement prose)

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"audit","subtype":"spec","target":{"paths":["/project/.mma/specs/2026-05-12-feature-design.md"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
```

### Skill audit (SKILL.md)

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"audit","subtype":"skill","target":{"paths":["/project/packages/server/src/skills/mma:audit/SKILL.md"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
```

### Plan audit (verify a code-execution plan against the codebase)

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"audit","subtype":"plan","target":{"paths":["/project/.mma/plans/2026-05-10-feature.md"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
```

## Polling for task completion

After a tool call returns a `taskId`, poll `GET /task/:taskId` until the task
reaches a terminal state.

### HTTP response shapes

| Status | Content-Type | Meaning |
|---|---|---|
| `202` | `application/json` | Still working — body is structured progress: `{ taskId, status, phase, elapsedMs, phaseElapsedMs, startedAt }` |
| `200` | `application/json` | Terminal — body is the uniform 6-field envelope (see `response-shape.md`) |
| `404` / `401` / other | — | Error — stop polling |

### Terminal envelope states

Every terminal envelope has the same six fields; inspect `error` to tell
which terminal state you're in:

| Shape | Meaning |
|---|---|
| `error` is a real object | Task failed — read `error.code` + `error.message` |
| `error` is `null` | Task succeeded — read `output.summary` |

### Poll loop (POSIX sh)

```bash
DELAY=1
START=$(date +%s)
TIMEOUT_S=${MMA_POLL_TIMEOUT_S:-1800}
BODY_FILE=$(mktemp -t mma-poll.XXXXXX)
trap 'rm -f "$BODY_FILE"' EXIT

while true; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$TIMEOUT_S" ]; then
    echo "mma: poll timed out after ${TIMEOUT_S}s" >&2
    exit 124
  fi

  STATUS=$(curl -f --show-error -o "$BODY_FILE" -w "%{http_code}" -s \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$PORT/task/$TASK_ID" || true)

  case "$STATUS" in
    202)
      cat "$BODY_FILE"; echo
      sleep "$DELAY"
      DELAY=$(( DELAY < 30 ? DELAY * 2 : 30 ))
      ;;
    200)
      cat "$BODY_FILE"
      exit 0
      ;;
    "")
      echo "mma: unreachable (curl failed)" >&2; exit 1 ;;
    *)
      echo "mma: HTTP $STATUS"; cat "$BODY_FILE" >&2; exit 1 ;;
  esac
done
```

Start at 1 s, double each iteration, cap at 30 s. The 1800-second client-side
timeout is a safety cap; most tasks complete in under 60 s. Discover `$PORT`
at runtime with `mma info --json | jq -r .port` (default: 7337).

### Caller-side tool-timeout note

The poll helper's internal `TIMEOUT_S` default is 1800s (30 minutes). If your
agent's shell tool (e.g. Claude Code's Bash) caps command wall-clock at
10 minutes by default, the helper will be killed at 10m regardless of
`TIMEOUT_S` — long-running delegations then appear to "fail" before terminal.

When invoking this poll loop, pick one:

- **Preferred — pass a 30-minute tool timeout explicitly** (e.g. Claude Code
  Bash accepts `timeout: 1800000`, up to 600000ms/10 min by default; pass the
  max the tool allows, or bump the tool's allowed ceiling via harness
  settings).
- **Alternative — cap the helper to match the tool's limit** by exporting
  `MMA_POLL_TIMEOUT_S=600` before running the loop. The helper will then
  exit 124 cleanly at 10 minutes and the caller can decide whether to
  re-poll or surface the timeout.

Never let the helper run longer than the caller's tool cap — the process
gets killed mid-poll, the caller sees a generic failure, and diagnostics
from the `TIMEOUT_S` exit path are lost.

Windows/PowerShell equivalent is planned for a later release.


## Response shapes

### POST /task?cwd=<abs> — dispatch response (202)

```json
{ "taskId": "<uuid>", "statusUrl": "/task/<uuid>" }
```

Use `taskId` to poll. `statusUrl` is a convenience pointer.

### GET /task/:taskId — terminal response (200)

The terminal JSON envelope has these 6 top-level fields:

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

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { /* optional structured context, e.g. fieldErrors for 400 */ }
}
```

`details` is optional and present only when the server has structured additional context.


## Reading the findings

The main agent reads findings from the terminal envelope at `output.summary.findings` (NOT `output.findings` — that field does not exist). `output.summary` is the parsed refiner JSON; findings are nested inside it. Read-only routes like `mma:audit` do not produce commits — `execution.worktree` is always `null`.

### Finding shape

Every finding in `output.summary.findings` has this shape:

| Field | Type | Notes |
|---|---|---|
| `weight` | `'critical' \| 'high' \| 'medium' \| 'low'` | Severity tier. |
| `category` | string | Topical bucket, e.g. `path-existence`, `prose-coherence`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string | Verbatim from source when grounded. |
| `suggestion` | string | Fix recommendation. |

### Recommended rendering by the main agent

1. Show ALL findings — never silently drop. Weight and grounding are soft
   signals, not gates.
2. Default sort: weight (critical → low).
3. `weight` is the authoritative severity — use it directly.
4. Mark findings with `evidence` shorter than 30 chars as "low-evidence"
   (lighter color or `(low evidence)` annotation). User decides what to do.
5. Weight-tier counts feed the dashboard.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma:audit`:

- **Recipe A — Audit-iterate-clean.** `mma:audit` → fix → `mma:audit` again. Sequential rounds. Register the doc via `mma:context-blocks` before round 1 and reuse the same ID across all rounds — avoids re-inlining the same content into every audit call.

- **Recipe E — Plan-validate-execute.** Before any `mma:execute-plan` batch, run `mma:audit` with `subtype: 'plan'` on the plan file. Read the findings. If any `critical` / `high` finding survives, fix the plan and re-audit. This catches the bug class where the plan's named methods/files don't actually exist in the codebase — symbols a prose-coherence audit cannot see.

- **Recipe F — Spec-then-plan-then-execute (the canonical flow).** When working from a brainstorming spec: `mma:audit` (`subtype: 'spec'`) → fix → `writing-plans` → register the spec as a context block via `mma:context-blocks` → `mma:audit` (`subtype: 'plan'`, `contextBlockIds: [specBlockId]`) → fix → `mma:execute-plan`. Spec audit covers requirement-prose executability; plan audit covers BOTH plan-vs-codebase coherence AND plan-vs-spec coverage (perspective 10 fires only when the spec is in context, which is why the context-block step is load-bearing in this recipe).

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel audits on the same document re-flag the same issues without seeing each other's fixes. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Auditing source code with `mma:audit`**
The auditor lacks codebase context (no type info, no call-site lookup, no test awareness). Findings are speculative. **Fix:** use `mma:review` — it pulls in surrounding source context and validates against the actual types.

❌ **Single huge `target.inline` string instead of `target.paths`**
Inline docs lose the file boundary, so the per-file parallel split degenerates to one worker. **Fix:** save to disk first, pass `target.paths`.

❌ **Sending the legacy `auditType` field**
The field was renamed to `subtype` and the value set was narrowed. **Fix:** use `subtype` with one of `default` / `plan` / `spec` / `skill`. For "security only" / "performance only" lenses, put the bias in the free-text prompt — there is no narrow-lens subtype.

❌ **Re-auditing the same files round after round without delta context**
Round 2 worker has no idea what round 1 found. **Fix:** register the round 1 findings as a context block (`mma:context-blocks`) and pass `contextBlockIds` to round 2.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Pass round-N audit findings to round N+1 via `contextBlockIds`
- Feed audit results into a downstream `mma:delegate` fix step
- Accumulate findings across iterative audit rounds

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** An audit with zero findings is a success — it means the document passed all criteria. Check `output.summary.findings.length === 0`.

## Error handling

### HTTP status decision table

| Status | Code | Action |
|---|---|---|
| `400` | `invalid_request` | Fix the request body or query params |
| `401` | `unauthorized` | Verify token matches `~/.mma/auth-token` |
| `403` | `forbidden` | `cwd` query param missing or out of scope |
| `404` | `not_found` | Wrong `taskId` or resource does not exist |
| `409` | `invalid_task_state` / `pinned` | Task in wrong state; check current state first |
| `413` | `payload_too_large` | Reduce content size (context block or body) |
| `429` | `rate_limited` | Wait `Retry-After` seconds, then retry |
| `503` | `project_cap_exceeded` | Too many concurrent projects; wait and retry |
| `5xx` | server error | Retry once after 2 s; escalate if it persists |

### Network failures

Retry up to 3 times with exponential backoff (1 s → 2 s → 4 s).
If the server is unreachable, check that `mma serve` is running:
```bash
curl -s http://localhost:$PORT/health   # expects { "status": "ok" }  (v4.0 — see spec C13)
```

### Auth errors (401)

```bash
export MMA_AUTH_TOKEN=$(mma print-token)
```

The token persists across restarts at `~/.mma/auth-token`. It only changes if the file is manually deleted.

