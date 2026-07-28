---
name: mma-journal-record
description: Use when you've learned something worth remembering — a decision, design rationale, user behavior pattern, process learning, research finding, or style convention. Records it to the persistent team knowledge graph for future sessions.
when_to_use: You've completed analysis and want to log the outcome — a decision (tried X, use Y), design rationale (why the architecture works this way), user behavior (how the user prefers to work), process learning (what works in the SDLC), research finding (API feasibility, ecosystem fact), or style convention (documentation/code norms). NOT for recall/investigate/delegate; those are read routes. Journal stores team knowledge for cross-session reference.
version: "0.0.0-unreleased"
---

# mma-journal-record

## Overview

Record team knowledge to the persistent journal via a fire-and-forget mma worker. The worker integrates the entry into the knowledge graph and returns immediately; you continue on your main context.

**Core principle:** The journal is the centralized team knowledge graph — decisions, design rationale, user behavior patterns, process learnings, research findings, and style conventions. Record once per insight; don't re-investigate.

## When to Use

**Use when:**
- You've made a **decision** — tried X, dropped it, use Y instead
- You've understood a **design rationale** — why the architecture/pattern is structured this way
- You've observed a **user behavior** — how the user prefers to work, communicate, or explore
- You've learned a **process** — what works in the SDLC, what phases/gates are effective
- You've discovered **knowledge** — API feasibility, ecosystem facts, research findings
- You've identified a **style convention** — documentation norms, code patterns, naming rules
- You've hit a blocking constraint worth remembering
- You want to avoid repeating a dead-end direction next session

**Don't use when:**
- You're asking a question → `mma-investigate`
- You're dispatching work → `mma-delegate`
- You want to retrieve past entries → `mma-journal-recall`
- You're mid-task and want to pause → that's what `blockedBy` is for; journal is for conclusions, not temporary blockers

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
  "type": "journal_record",
  "records": [
    {
      "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it — git diff is the source of truth. Lesson: use getRealFilesChanged.",
      "topic": "grouped-dispatch"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `records` | array | yes | Canonical request field. Provide 1 to 20 structured record objects in submission order; one request runs one sequential `journal_record` pipeline — the agent processes the records one-by-one and returns a per-record `recorded[]` / `failed[]` result. |
| `records[].prompt` | string | yes | A natural-language entry: what you decided, why, or what you learned. Keep it concrete (min 1 char). |
| `records[].topic` | string | no | Optional caller-supplied primary subject. Must already be lowercase-kebab. When provided, the worker uses it verbatim. When omitted, the system infers one topic per record from the learning content and existing journal topics. |

**Legacy compatibility (still accepted).** A legacy single-record body of `{ "type": "journal_record", "prompt": "...", "topic": "..." }` is normalized to a one-element `records` array at the request boundary, so existing callers keep working unchanged. Do not mix the two shapes — a body carrying both `records` and a top-level `prompt`/`topic` is rejected with `400 invalid_request`.

**What gets stored & where:**

Entries are integrated into a graph-structured journal store at `.mma/journal/`:
- `nodes/` — individual learning entries (keyed by unique node ID)
- `index.md` — searchable index of all entries, topics, tags, and cross-references
- `log.md` — append-only event log of create/refine/supersede/merge operations

The worker creates, refines, or supersedes nodes in the graph (never appends blindly). The derived `index.md` catalog uses the column order `id | timestamp | type | status | title | topic | tags`. Legacy rows may be regenerated with `topic: unscoped` without rewriting historical node files.

## Review contract (deterministic engine)

The implementer emits one structured decision per record; a **deterministic engine** applies the batch and enforces the mechanical invariants in **code** — id uniqueness, node schema, edge integrity (no dangling/self links), and submitted-record completeness (every record lands in `recorded[]` or `failed[]`). Because these guarantees are code-enforced, the LLM reviewer is redundant for them and is **skipped when the invariants pass** and the caller did not force review.

| `reviewPolicy` | Reviewer runs? |
|---|---|
| omitted (default) | Skipped when invariants pass; runs if they fail |
| `none` | Skipped when invariants pass; runs if they fail |
| `reviewed` | **Always** runs |

Pass `reviewPolicy: "reviewed"` to force a full LLM review pass (e.g. to sanity-check type classification or topic inference). The default and `"none"` both allow the skip. This is intentional — the deterministic engine replaces redundant review, it does not weaken the guarantees.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "journal_record",
    "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it. Lesson: use getRealFilesChanged.",
    "topic": "grouped-dispatch"
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


## Best practices

**One entry per decision, not per turn.**
Log once when you decide not to pursue a direction; don't log "just checked X" on every iteration.

**Use `topic` when you already know the primary subject.**
Provide a caller-supplied `topic` for stable subsystem names so the worker does not have to infer one. When you omit `topic`, the worker infers one from the learning content and exact-slug matches against existing journal topics.

**Keep entries concrete.**
❌ "Didn't work"  
✅ "Tried multicast-style dispatch with worker dedup; git diff is the source of truth, workers can't track cancellations atomically. Use getRealFilesChanged instead."

## Common pitfalls

❌ **Using journal as a scratchpad**
> "Thinking about X. Maybe Y? Need to check Z."

Journal is for **conclusions**, not work-in-progress. Keep notes in a separate working file if you need to brainstorm.

❌ **Logging without context**
> "Doesn't work."

Future-you (or a teammate) won't remember what "doesn't work" means. Always include the decision frame: what did you try, why did you try it, what was the outcome, and what will you do instead?

❌ **Sending a non-normalized topic**
> `"topic": "Worker Runtime"`

The request schema accepts only lowercase-kebab topics. Fix it before dispatch: `"topic": "worker-runtime"`.

## Context blocks

Write-route tasks (delegate / execute-plan / journal) do **not** register terminal context blocks. Their artifact is the filesystem mutation (git commit for delegate; graph mutations for journal). Read-route tasks (audit / review / debug / investigate / research) auto-register blocks containing their findings.

## Multi-repo mode (parent-aware)

In a parent-aware multi-repo flow, records go to the **parent** workspace **journal** (one product-level
store, reached with `cwd = parent workspace`). Pass `topic = <repo-slug>` (normalized **lowercase-kebab**,
e.g. `multi-model-agent`) to scope a learning to the repo it came from. Single-project mode is unchanged.

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

