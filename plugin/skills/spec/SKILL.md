---
name: spec
description: Use when you have structured design decisions ready and need a formal specification document written by a worker instead of consuming main-context tokens
when_to_use: You have completed an interactive design session (brain dump → investigation → structuring → user confirmation) and all sections are confirmed. You want a formal, structured spec written to disk by a worker. If you are still in the interactive design phase → stay in mma:brainstorm. If you already have a spec and need a plan → use mma:plan.
version: "0.0.0-unreleased"
---

# mma:spec

## Overview

Dispatch structured design decisions to a complex worker that writes a formal specification document. The worker expands confirmed decisions into a complete spec with YAML frontmatter, explicit contracts, testable acceptance criteria, and the standard section structure.

**Core principle:** The interactive design work (brain dump, investigation, structuring, decision-making) has already happened in the main session. This skill hands the confirmed decisions to a worker that writes the formal document — labor, not judgment.

## When to Use

**Use when:**
- You have structured design decisions with all sections confirmed by the user
- The sections cover the eight canonical components: Context, Problem, Goals & Requirements, Alternatives, Technical Design, Testing Plan, Risks & Mitigations, User Stories & Tasks
- You want a formal spec written to disk

**Don't use when:**
- You are still exploring the problem space → `mma:explore` or `mma:investigate`
- You are still in the interactive design phase → `mma:brainstorm`
- You already have a spec and need a plan → `mma:plan`
- You need to audit an existing spec → `mma:audit subtype:spec`

## Endpoint

`POST /task?cwd=<abs-path>`

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
  "type": "spec",
  "prompt": "Subset-compatible spec request",
  "target": {
    "inline": "## Context\n\n### Background\n..."
  },
  "components": ["Context", "Problem", "Technical Design"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"spec"` | yes | Literal route discriminator — must be exactly `"spec"` |
| `prompt` | string | yes | Feature title + one-line summary. Its first sentence becomes the filename slug **only when self-naming** (no dated input and no explicit `outputPath`) — when a dated input is present the stem is inherited from it (see `outputPath`) |
| `target` | object | yes | Container — must have exactly one of `inline` or `paths`, not both |
| `target.inline` | string | primary | The structured design decisions as markdown with section headings |
| `target.paths` | string[] | alternative | Path(s) to structured input files. The **first** file is the authoritative confirmed decisions (markdown with spec section headings). Any **additional** files — e.g. an `exploration.md` from `mma:explore` — are **grounding/reference only**: the worker reads them for context but never treats their options / rough directions as decisions. |
| `outputPath` | string | no | Where to write the spec (relative to cwd, must not contain `..` or be absolute). When omitted, the default **inherits the stem** from the first `YYYY-MM-DD-`-prefixed entry in `target.paths` (the exploration) → `.mma/specs/<that-stem>.md`, so the exploration → spec → plan chain shares one stem; undated inputs (scratchpad scaffolds) are skipped. Falls back to `.mma/specs/<today>-<prompt-slug>.md` only when no dated input is present. Every `target.paths` entry must resolve, else the task fails `invalid_request`. |
| `components` | string[] | no | Optional subset of canonical top-level component labels. Allowed labels: `Context`, `Problem`, `Goals & Requirements`, `Alternatives`, `Technical Design`, `Testing Plan`, `Risks & Mitigations`, `User Stories & Tasks`. Omitted or empty `components` means all eight components. |
| `reviewPolicy` | `"reviewed"` \| `"none"` | no | Default `"reviewed"` (two-phase pipeline with refiner). Set `"none"` to skip review |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) for additional context |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Structured decisions format

The `target.inline` content must be a markdown document with any of these eight canonical top-level headings (in any order — the worker will preserve canonical order):

- `## Context`
- `## Problem`
- `## Goals & Requirements`
- `## Alternatives`
- `## Technical Design`
- `## Testing Plan`
- `## Risks & Mitigations`
- `## User Stories & Tasks`

If the `components` field is provided, only those components need to be present in the input; the worker will emit exactly the requested subset. In other words, omitted or empty `components` means all eight components. The worker expands terse sections (the worker adds prose) or preserves detailed sections.

### `reviewPolicy` — review lifecycle per task

All task types default to `"reviewed"` (two-phase pipeline: implementer + refiner).
Only `orchestrate` forces `"none"`. Callers can override per-request.

For read-only routes (audit, review, debug, investigate, research, journal_recall),
the refiner verifies the implementer's output against source material — checking
citations, evidence accuracy, and completeness. For write routes (delegate,
execute_plan, journal_record), the refiner also fixes issues in the worktree.

| Value | Behavior | Use when |
|---|---|---|
| `"reviewed"` | Two-phase pipeline: implement + review (default) | Default for all types |
| `"none"` | Skip the review stage | Trivially mechanical edits or throwaway scripts where a second-pass reviewer adds nothing |


## Full example

```bash
RESULT=$(curl -f -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "spec",
    "prompt": "Database-free claims demo — file-backed default with parity proof",
    "target": { "inline": "## Context\n### Background\nThe team maintains a self-service claims demo...\n## Problem\nThe demo cannot run without first standing up a database...\n## Goals & Requirements\n### Goals\n1. Instant start — no database needed\n## Alternatives\n### Option A: Repo seam + file hydration (recommended)\n### Option B: Embedded store\n## Technical Design\n### Proposed\nClaimsRepository interface + FileClaimsRepository\n## Testing Plan\nUnit + integration + parity\n## User Stories & Tasks\n- [ ] AC-1: Runs without database" }
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
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


## Reading the result

The terminal envelope's `output.summary` contains:

```json
{
  "specPath": ".mma/specs/2026-07-06-claims-demo.md",
  "sections": ["Context", "Problem", "Goals & Requirements", "Alternatives", "Technical Design", "Testing Plan", "Risks & Mitigations", "User Stories & Tasks"],
  "acceptanceCriteriaCount": 15,
  "notes": "Verified 3 codebase paths; expanded terse Constraints section with measurable targets"
}
```

| Field | Type | Meaning |
|---|---|---|
| `specPath` | string | Path where the spec was written (relative to cwd) |
| `sections` | string[] | List of sections included in the spec |
| `acceptanceCriteriaCount` | number | Count of AC-X.X entries in the spec |
| `notes` | string | Worker observations, codebase verification results, reviewer fixes applied |

## Natural next step

The spec is written and you're back in the main agent. Usual next moves (soft suggestions — none forced):
- **Audit it** → `mma:audit` (subtype: spec) — catch ambiguity or untestable requirements before planning.
- **Write the plan** → `mma:plan` — turn the spec into an ordered TDD implementation plan.

## Best practices

- **Gather all sections before dispatching.** The worker writes the formal spec from confirmed decisions — if a section is missing, the worker must invent it, which defeats the purpose.
- **Inline for small, fresh decisions.** `target.inline` is the default — pass the structured decisions directly from the design session.
- **Write a tmp scaffold file + `target.paths` once the content is large or heavily structured** (tables, code fences, many sections — roughly >8 KB). A path has no JSON-escaping surface and keeps the dispatch body small; the driver is escaping fragility, not size alone. **Write the scaffold to your scratchpad / system temp directory, never inside the target repo** (e.g. `<scratchpad>/spec-decisions.md`, not `<repo>/.mma-spec-scaffold.md`) — it's a throwaway dispatch artifact, not a project file, so keep it out of the working tree. Pass an absolute path in `target.paths`. Delete the scaffold after `specPath` returns. `target.paths` also covers re-spec from an existing outline on disk.
- **Pass upstream grounding (e.g. an `exploration.md`) as an ADDITIONAL `target.paths` file, after the decisions.** `target` is exactly-one-of `inline`/`paths`, so when the worker should have both the decisions and a grounding file, put both in `target.paths` — decisions **first** (authoritative, what it expands), grounding **second** (context only; the worker never treats its rough options as decisions).
- **Register large context via `mma:context-blocks`.** If the design decisions reference large documents (prior specs, investigation reports), register them as context blocks and pass `contextBlockIds`.

## Common pitfalls

❌ **Dispatching before all sections are confirmed.** The worker cannot make design decisions — it writes what it receives. Missing sections produce incomplete specs. **Fix:** complete the interactive design phase (all requested top-level components confirmed by the user; if `components` is omitted or empty, that means all 8 top-level sections, including the Scope/Constraints/Success Metrics subsections under Goals & Requirements) before dispatching.

❌ **Sending raw brain dump instead of structured decisions.** The worker expects markdown with the standard section headings. An unstructured text dump produces a poorly organized spec. **Fix:** structure the content with the required `##` headings before passing as `target.inline`.

❌ **Inlining a large, table-heavy decisions doc as a JSON string.** Embedding many `##` sections, tables, and code fences into a shell-assembled JSON string breaks the dispatch (escaping/heredoc failures). **Fix:** write the decisions to a tmp scaffold file **in your scratchpad / system temp dir (not inside the repo)** and pass its absolute path via `target.paths`.

❌ **Using this instead of `mma:audit subtype:spec`.** This writes a spec; audit verifies one. If you already have a spec and want it checked, use audit. **Fix:** dispatch `mma:audit subtype:spec` to verify an existing spec.

## Multi-repo mode (parent-aware)

In multi-repo mode the **parent workspace owns the spec output in multi-repo mode** — the spec is a single
shared artifact under the parent `.mma/specs/`, never forked per repo.
**One shared spec feeds per-repo plans** (mma:plan then fans out one plan per involved repo).
Single-project mode is unchanged.

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

