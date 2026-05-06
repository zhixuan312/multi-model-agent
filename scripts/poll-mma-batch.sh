#!/usr/bin/env bash
# scripts/poll-mma-batch.sh — poll a multi-model-agent batch until terminal.
#
# Usage:
#   scripts/poll-mma-batch.sh <batch-id> [output-file]
#
# Behavior:
#   - Polls GET /batch/<id> with exponential backoff (1s -> 30s cap).
#   - Prints the running-headline body for every 202.
#   - On 200 (terminal), saves the JSON envelope to <output-file>
#     (default: /tmp/mma-batch-<id>.json) and exits 0.
#   - On 4xx/5xx or unreachable server, exits non-zero.
#
# Environment:
#   MMAGENT_AUTH_TOKEN   override the auth token (else read via `mmagent print-token`)
#   MMAGENT_PORT         override the port (else read via `mmagent info --json`, default 7337)
#   MMAGENT_POLL_TIMEOUT_S   client-side cap (default 1800 = 30 min)
#   MMAGENT_POLL_QUIET   1 = suppress per-tick headline echoes (only print on terminal/error)
#
# Run in background:
#   scripts/poll-mma-batch.sh <batch-id> /tmp/mma-out.json &
#   tail -f /tmp/mma-out.json   # (after terminal)
#
# Or (stream tick lines to a log):
#   scripts/poll-mma-batch.sh <batch-id> /tmp/mma-out.json > /tmp/mma-progress.log 2>&1 &

set -euo pipefail

BATCH_ID="${1:-}"
OUT_FILE="${2:-/tmp/mma-batch-${BATCH_ID}.json}"

if [ -z "$BATCH_ID" ]; then
  echo "usage: $0 <batch-id> [output-file]" >&2
  exit 2
fi

# Resolve token and port lazily so an outdated environment can self-recover.
TOKEN="${MMAGENT_AUTH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(mmagent print-token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "[poll-mma-batch] could not obtain auth token (set MMAGENT_AUTH_TOKEN or run mmagent print-token)" >&2
  exit 3
fi

PORT="${MMAGENT_PORT:-}"
if [ -z "$PORT" ]; then
  PORT="$(mmagent info --json 2>/dev/null | jq -r .port 2>/dev/null || echo 7337)"
fi

URL="http://127.0.0.1:${PORT}/batch/${BATCH_ID}"
TIMEOUT_S="${MMAGENT_POLL_TIMEOUT_S:-1800}"
QUIET="${MMAGENT_POLL_QUIET:-0}"

START_TS="$(date +%s)"
DELAY=1
BODY_FILE="$(mktemp -t mma-poll.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

LAST_HEADLINE=""
echo "[poll-mma-batch] batch=${BATCH_ID} url=${URL} out=${OUT_FILE}"

while :; do
  NOW="$(date +%s)"
  ELAPSED=$((NOW - START_TS))
  if [ "$ELAPSED" -ge "$TIMEOUT_S" ]; then
    echo "[poll-mma-batch] timeout after ${TIMEOUT_S}s" >&2
    exit 124
  fi

  # -o body, -w status; never error on non-2xx so we inspect the code below.
  STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" "$URL" 2>/dev/null || true)"

  case "$STATUS" in
    202)
      if [ "$QUIET" != "1" ]; then
        HEADLINE="$(cat "$BODY_FILE" 2>/dev/null || true)"
        if [ "$HEADLINE" != "$LAST_HEADLINE" ]; then
          printf '[t=%4ds] %s\n' "$ELAPSED" "$HEADLINE"
          LAST_HEADLINE="$HEADLINE"
        fi
      fi
      sleep "$DELAY"
      DELAY=$(( DELAY < 30 ? DELAY * 2 : 30 ))
      ;;
    200)
      cp "$BODY_FILE" "$OUT_FILE"
      printf '[poll-mma-batch] terminal at t=%ds — wrote %s (%s bytes)\n' \
        "$ELAPSED" "$OUT_FILE" "$(wc -c <"$OUT_FILE" | tr -d ' ')"
      exit 0
      ;;
    "")
      echo "[poll-mma-batch] curl failed (server unreachable?)" >&2
      exit 1
      ;;
    *)
      echo "[poll-mma-batch] HTTP ${STATUS}" >&2
      cat "$BODY_FILE" >&2 || true
      exit 1
      ;;
  esac
done
