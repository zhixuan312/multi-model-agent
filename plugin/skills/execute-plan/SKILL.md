---
name: execute-plan
description: Use when a plan or spec file exists on disk (any markdown with task headings — .mma/plans/*.md, a TODO list, a spec doc) and you need to implement one or more tasks from it sequentially in one worker session
when_to_use: A plan file exists on disk AND you need to implement one or more tasks from it AND mma is running. Prefer this over inline Agent dispatches — workers are cheaper and don't pollute main context. Task descriptors must match plan headings verbatim.
version: "0.0.0-unreleased"
---

# mma:execute-plan

## Overview

Dispatch Contract Tasks from a **contract-first** plan file to a single worker session. The `tasks` array selects which Contract Task headings to execute — the worker receives them all in one prompt and executes them sequentially in plan order within one worktree. Empty `tasks` = run all.

**Core principle:** The plan IS the prompt. The worker is an **autonomous** implementer of each task's contract — it implements freely and makes the plan-authored acceptance tests pass, rather than copying implementation code.

## Contract-first execution (what the worker does)

- The plan must be a contract-first plan (frozen Contract Task format). A legacy/non-conforming plan is rejected before any worker starts, with a terminal `status: "failed"`.
- The pipeline validates and materializes each task's plan-authored acceptance tests, then **re-materializes them from the plan before scoring** — so an executor cannot weaken them.
- Completion is scored from contract satisfaction + the passing acceptance-test run; the commit gate is unchanged at **completionPercent >= 80**.
- Pre-dispatch/materialization failures surface as specific terminal error codes: `unsupported-legacy-plan`, `malformed-plan`, `unsafe-test-path`, and `test-path-collision`.

## When to Use

**Use when:**
- A plan/spec markdown exists with numbered task headings
- You want to dispatch a subset (or all) of those tasks
- Tasks are sequential (later tasks build on earlier ones) — the worker handles ordering

**Don't use when:**
- No plan file → `mma:delegate` (pass the prompt directly)
- The "plan" is in conversation only, not on disk → write it to disk first, or use `mma:delegate`

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
  "type": "execute_plan",
  "prompt": "Focus on the backend tasks only",
  "tasks": [
    "1. Add input validation to login handler",
    "2. Write unit tests for the auth module"
  ],
  "target": {
    "paths": ["/project/.mma/plans/2026-07-11-feature.md"]
  },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no | Optional caller context for the worker (e.g. "focus on backend tasks", "skip tests") — injected alongside the plan content |
| `tasks` | string[] | no | Task selectors matching plan headings. Empty or omitted = run all tasks in the plan |
| `target.paths` | string[] | yes | EXACTLY one entry: the plan markdown file |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) — the right place for source files referenced by the plan |

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


> Worker tier defaults to `standard`. Send `agentTier` to override if needed.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"execute_plan","tasks":["3. Migrate database schema"],"target":{"paths":["/project/.mma/plans/2026-07-11-feature.md"]}}' \
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

### GET /task/:taskId — polling response

The HTTP status is the state discriminator:

| Status | Meaning |
|---|---|
| `202 application/json` | Still pending — body is structured progress JSON: `{ taskId, status, phase, elapsedMs, phaseElapsedMs, startedAt }` |
| `200 application/json` | Terminal — body is the task envelope below |
| `404` / `401` / `5xx` | Error — see Error response below; stop polling |

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { /* optional structured context, e.g. fieldErrors for 400 */ }
}
```

`details` is optional and present only when the server has structured additional context.

## Natural next step

Tasks are implemented. Usual next moves (soft suggestions — none forced):
- **Review the changes** → `mma:review` on the changed files.
- **Re-run only the failures** → a fresh `mma:execute-plan` scoped to ONLY the failed task headings (pass just those in `tasks[]`), never a full re-dispatch that re-charges the successful tasks.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma:execute-plan`:

- **Recipe C — Investigate-plan-execute.** `mma:investigate` → write the plan → `mma:execute-plan`. Register the plan file as a context block before the execute-plan call so it isn't re-inlined into every worker's prompt.

Anti-pattern alert: **`full-batch-redispatch`** (AP4). When the dispatch returns mixed `done` / `failed`, do NOT re-run the whole task list — dispatch a fresh `mma:execute-plan` scoped to ONLY the failed task headings (`tasks[]`). Re-running the whole list re-charges every successful task.

## Common pitfalls

❌ **Task descriptor doesn't match plan heading verbatim**
> tasks: ["Migrate db schema"]    ← plan heading is "3. Migrate database schema"

Worker rejects with "no matching task" or matches the wrong one. **Fix:** copy the heading from the plan, including the leading number.

❌ **Forgetting the plan file in `target.paths`**
> target.paths: ["/project/src/db/schema.sql"]    ← no plan file

Worker can't read the task body. **Fix:** always include the plan path: `target.paths: ["/project/.mma/plans/2026-07-11-feature.md"]`.

execute_plan handles dependencies naturally since tasks run sequentially in one session — the worker executes them in order within a single worktree.

## Terminal context block

Write-route tasks (delegate / execute-plan) do NOT register a terminal context block — their durable record is the commit (merged worktree branch + `output.filesChanged`). The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


## Non-git targets

Execution is **one plan file** per request. Git targets use worktree isolation; **non-git** targets run
**in-place** (no worktree, edits the folder directly), skipping branch/PR/merge. No new execution task type
is introduced, and git is never forced.

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

