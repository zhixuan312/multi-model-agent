## Authentication & identity headers

Every request to the multi-model-agent server requires:

| Header | Required for | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | All routes (except `/health`) | Auth — token from `mmagent print-token` |
| `X-MMA-Client: <client>` | All tool routes | Identifies your client. One of `claude-code`, `cursor`, `codex-cli`, `gemini-cli`. **Server returns `400 client_required` if missing.** |
| `X-MMA-Main-Model: <model-id>` *(optional)* | All tool routes | Override the auto-detected calling model id. When omitted the server resolves per-client (claude-code reads the latest `~/.claude/projects/<slug>/*.jsonl`; codex-cli reads `~/.codex/config.toml`) and falls back to `defaults.mainModel` in config, then to `unknown_main_model`. |

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
MMA_CLIENT="${MMAGENT_CLIENT:-claude-code}"

curl \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  ...
```

### Errors

- `401 unauthorized` — re-run `mmagent print-token`; the token may have changed after a server restart.
- `400 client_required` — `X-MMA-Client` header is missing on a tool route. Set it to one of: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`.
