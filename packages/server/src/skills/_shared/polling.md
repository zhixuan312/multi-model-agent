## Polling for batch completion

After a tool call returns a `batchId`, poll `GET /batch/:id` until the batch
reaches a terminal state.

### HTTP response shapes (3.1.0)

| Status | Content-Type | Meaning |
|---|---|---|
| `202` | `text/plain` | Still working — body is the running headline (e.g. `1/1 running, 47s elapsed`) |
| `200` | `application/json` | Terminal — body is the uniform 7-field envelope (see `response-shape.md`) |
| `404` / `401` / other | — | Error — stop polling |

### Terminal envelope states

Every terminal envelope has the same seven fields; inspect these to tell
which terminal state you're in:

| Shape | Meaning |
|---|---|
| `error` is a real object | Batch failed — read `error.code` + `error.message` |
| `proposedInterpretation` is a string | Batch is awaiting clarification — invoke `mma-clarifications` |
| Both are `{kind: "not_applicable", ...}` | Batch succeeded — read `results` |

### Poll loop (POSIX sh)

```bash
DELAY=1
START=$(date +%s)
TIMEOUT_S=${MMAGENT_POLL_TIMEOUT_S:-1800}
BODY_FILE=$(mktemp -t mmagent-poll.XXXXXX)
trap 'rm -f "$BODY_FILE"' EXIT

while true; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$TIMEOUT_S" ]; then
    echo "mmagent: poll timed out after ${TIMEOUT_S}s" >&2
    exit 124
  fi

  STATUS=$(curl -f --show-error -o "$BODY_FILE" -w "%{http_code}" -s \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$PORT/batch/$BATCH_ID" || true)

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
      echo "mmagent: unreachable (curl failed)" >&2; exit 1 ;;
    *)
      echo "mmagent: HTTP $STATUS"; cat "$BODY_FILE" >&2; exit 1 ;;
  esac
done
```

Start at 1 s, double each iteration, cap at 30 s. The 1800-second client-side
timeout is a safety cap; most batches complete in under 60 s. Discover `$PORT`
at runtime with `mmagent info --json | jq -r .port` (default: 7337).

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
  `MMAGENT_POLL_TIMEOUT_S=600` before running the loop. The helper will then
  exit 124 cleanly at 10 minutes and the caller can decide whether to
  re-poll or surface the timeout.

Never let the helper run longer than the caller's tool cap — the process
gets killed mid-poll, the caller sees a generic failure, and diagnostics
from the `TIMEOUT_S` exit path are lost.

Windows/PowerShell equivalent is planned for a later release.
