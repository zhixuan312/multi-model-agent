#!/usr/bin/env bash
# Supplies the MMA bearer token and client attribution to Claude Code as MCP
# connection headers.
#
# Read at CONNECT time, never stored in the plugin: rotating the token file is
# picked up on the next connection, and Claude Code re-runs this helper
# automatically if a call returns 401/403.
#
# Token resolution order:
#   1. $MMA_AUTH_TOKEN         (env override, matches the daemon's own override)
#   2. $MMA_TOKEN_FILE         (explicit path)
#   3. ~/.mma/auth-token       (default daemon location)
set -uo pipefail

if [ -n "${MMA_AUTH_TOKEN:-}" ]; then
  token="$MMA_AUTH_TOKEN"
else
  token_file="${MMA_TOKEN_FILE:-$HOME/.mma/auth-token}"
  if [ -r "$token_file" ]; then
    token="$(tr -d '\r\n' < "$token_file")"
  else
    # No token available — emit no credential rather than failing the connection,
    # so the user sees an auth error they can act on. The client header carries no
    # secret, so it still goes out.
    printf '{"X-MMA-Client":"agent-plugin"}\n'
    exit 0
  fi
fi

# JSON-escape the token defensively (a real token is base64url, but never
# hand-build JSON from unvalidated input).
escaped=$(printf '%s' "$token" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{"Authorization":"Bearer %s","X-MMA-Client":"agent-plugin"}\n' "$escaped"
