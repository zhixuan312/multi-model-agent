---
name: plan
description: Use when you have a spec file on disk and need a contract-first implementation plan written by a worker — produces ordered Contract Tasks (inputs/outputs/mapping/errors/invariants) with plan-authored acceptance tests and no implementation code, plus exact file paths
when_to_use: You have a formal specification on disk (written by mma:spec or manually) AND you want a contract-first implementation plan produced by a worker. If you don't have a spec yet → use mma:brainstorm to create one. If you have a plan and want to execute it → use mma:execute-plan. If you want to audit an existing plan → use mma:audit subtype:plan.
version: "0.0.0-unreleased"
---

# mma:plan

## Overview

Dispatch a spec file to a complex worker that writes a **contract-first** implementation plan. The worker reads the spec, explores the codebase, verifies ground truth at HEAD, then produces ordered **Contract Tasks** — each a contract (inputs, outputs, data mapping, errors, invariants) plus complete **plan-authored acceptance tests** and NO implementation code. The reviewer verifies every path and symbol against the real codebase.

**Core principle:** The spec defines WHAT to build. The plan defines the *contract* for each unit of work and the executable tests that pin it — then a capable executor implements freely against that contract. The plan does not dictate implementation code; the acceptance tests are the contract's teeth.

## When to Use

**Use when:**
- A spec file exists on disk (written by `mma:spec`, `mma:brainstorm`, or manually)
- You want a contract-first plan of Contract Tasks with plan-authored acceptance tests
- The plan will be executed via `mma:execute-plan`

**Don't use when:**
- No spec exists yet → `mma:brainstorm` (full design workflow) or `mma:spec` (write spec from decisions)
- You want to audit an existing plan → `mma:audit subtype:plan`
- You want to execute a plan → `mma:execute-plan`
- The task is simple enough for `mma:delegate` (no plan needed)

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
  "type": "plan",
  "prompt": "Write a TDD implementation plan for the database-free claims demo",
  "target": { "paths": ["/project/.mma/specs/2026-07-06-claims-demo.md"] }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"plan"` | yes | Literal route discriminator — must be exactly `"plan"` |
| `prompt` | string | yes | Goal description + any constraints beyond the spec |
| `target` | object | yes | Container — must have exactly one of `paths` or `inline`, not both |
| `target.paths` | string[] | primary | Path to the spec file (exactly one file) |
| `target.inline` | string | alternative | Spec content pasted directly. When using inline, `outputPath` is **required** |
| `outputPath` | string | conditional | Where to write the plan (relative to cwd, must not contain `..` or be absolute). Required when `target.inline` is used. When omitted with `target.paths`, the default **inherits the spec's dated stem** → `.mma/plans/<spec-stem>.md` (the first `YYYY-MM-DD-`-prefixed input; no double-date), so the plan shares the exploration/spec stem. An undated source falls back to `.mma/plans/<today>-<basename>.md`. |
| `reviewPolicy` | `"reviewed"` \| `"none"` | no | Whether the plan gets a reviewer pass. Default `"reviewed"` |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) for additional context |

Inline mode — `outputPath` is required because no basename can be derived:

```json
{
  "type": "plan",
  "prompt": "Write a TDD implementation plan for the database-free claims demo",
  "target": { "inline": "# Claims Demo Spec\n\n## Requirements\n..." },
  "outputPath": ".mma/plans/2026-07-06-claims-demo.md"
}
```

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Output path rules

| Input mode | `outputPath` provided? | Behavior |
|---|---|---|
| `target.paths` | No | Auto-derived: `.mma/plans/YYYY-MM-DD-<spec-basename>.md` |
| `target.paths` | Yes | Uses provided path |
| `target.inline` | No | HTTP 400 `invalid_request` — cannot derive basename from inline |
| `target.inline` | Yes | Uses provided path |

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
    "type": "plan",
    "prompt": "Write a TDD implementation plan for the database-free claims demo spec",
    "target": { "paths": ["/project/.mma/specs/2026-07-06-claims-demo.md"] }
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
  "planPath": ".mma/plans/2026-07-06-claims-demo.md",
  "taskCount": 17,
  "tasks": [
    { "title": "Task I-1: resolveDataSource", "verdict": "executable" },
    { "title": "Task I-2: Repository types", "verdict": "executable" },
    { "title": "Task I-3: Validate paging", "verdict": "partial" }
  ],
  "notes": "spec assumed src/utils/ but actual path is src/lib/; reconciled in all tasks"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `planPath` | string | yes | Path to the written plan file |
| `taskCount` | number | yes | Number of tasks in the plan |
| `tasks` | array of `{ title, verdict }` | yes | Per-task title + verdict (see below) |
| `notes` | string | no | Reconciliations or caveats the worker surfaced |

### Per-task verdicts

| Verdict | Meaning | Action |
|---|---|---|
| `executable` | Zero critical/high findings. Safe to dispatch to `mma:execute-plan` | Dispatch directly |
| `partial` | High findings, no critical. May execute but results are ambiguous | Review before dispatching |
| `blocked` | Critical findings. Would silently fail or mis-edit code | Fix the plan before dispatching |

### Plan structure (what the worker produces)

The plan file follows this structure:
- **Header:** Goal, Architecture, Tech Stack, Ground truth at HEAD
- **File Structure:** complete tree of all files to create/modify/test
- **Tracks:** logical groupings (2-6 tasks per track)
- **Tasks:** TDD structure (failing test → verify fail → implement → verify pass)
- **Track verification subsets** between track boundaries

## Natural next step

The plan is written. Usual next moves (soft suggestions — none forced):
- **Audit it against the codebase** → `mma:audit` (subtype: plan) — verify task ordering, signatures, and file paths before execution.
- **Execute it** → `mma:execute-plan` — implement the tasks on a worker.

## Best practices

- **One spec per plan.** Pass exactly one spec file. Multi-spec plans produce unfocused output.
- **Audit the plan after.** Run `mma:audit subtype:plan` on the produced plan for additional verification beyond the built-in reviewer.
- **Execute via `mma:execute-plan`.** The plan structure is designed for `mma:execute-plan` task matching — task headings map directly.

## Common pitfalls

❌ **Passing a brain dump instead of a spec.** The worker needs structured requirements to produce a correct plan. An unstructured prompt produces a vague plan. **Fix:** write a formal spec first via `mma:spec` or `mma:brainstorm`, then pass the spec file.

❌ **Using `target.inline` without `outputPath`.** The worker cannot derive a filename from inline content — provide `outputPath` explicitly.

❌ **Skipping `mma:audit subtype:plan` after.** The built-in reviewer checks 12 perspectives, but a standalone plan audit provides a second independent verification pass. **Fix:** dispatch `mma:audit subtype:plan` on the produced plan file before executing.

## Multi-repo mode (parent-aware)

In multi-repo mode, `/mma:flow` fans out **one** `mma:plan` dispatch per involved repo. Each dispatch plans
**exactly one repo**'s slice of the **shared spec** (two repo dispatches differ only in repo scope and
`outputPath`), and writes `.mma/plans/<stem>--<repo-slug>.md` under the parent workspace. Planning **one
repo** at a time keeps each plan a clean single-file `execute_plan` input. Single-project mode writes the
usual `<stem>.md`.

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

