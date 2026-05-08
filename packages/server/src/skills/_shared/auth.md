## Authentication & identity headers

Every request to the multi-model-agent server requires THREE headers:

| Header | Required for | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | All routes (except `/health`) | Auth — token from `mmagent print-token` |
| `X-MMA-Main-Model: <model-id>` | All tool routes (`/audit`, `/review`, `/delegate`, etc.) | Identifies YOUR model so cost-attribution + savings telemetry works. **Server returns `400 main_model_required` if missing.** |
| `X-MMA-Client: <client>` | All tool routes | Identifies your client. One of `claude-code`, `cursor`, `codex-cli`, `gemini-cli`. **Server returns `400 client_required` if missing.** |

### Obtain the token

**From environment variable** (preferred):
```
MMAGENT_AUTH_TOKEN=<token>
```

**From CLI**:
```bash
mmagent print-token
```

### Shell helper

```bash
TOKEN="${MMAGENT_AUTH_TOKEN:-$(mmagent print-token)}"

# Send Authorization + X-MMA-Main-Model + X-MMA-Client on every tool call.
# Replace <your-model-id> with the model you (the calling agent) are running on.
# Examples: claude-opus-4-7, claude-sonnet-4-6, gpt-5, gemini-2.5-pro
MAIN_MODEL="${MMAGENT_MAIN_MODEL:-claude-opus-4-7}"
MMA_CLIENT="${MMAGENT_CLIENT:-claude-code}"

curl \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Main-Model: $MAIN_MODEL" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  ...
```

### Errors

- `401 unauthorized` — re-run `mmagent print-token`; the token may have changed after a server restart.
- `400 main_model_required` — `X-MMA-Main-Model` header is missing on a tool route. Set it to your model id (e.g. `claude-opus-4-7`).
- `400 client_required` — `X-MMA-Client` header is missing on a tool route. Set it to one of: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`.
