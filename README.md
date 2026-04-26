# multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP service for delegating tool-using work to sub-agents on different LLM providers.

*(Replaced `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — see [CHANGELOG](./CHANGELOG.md).)*

## Why

- **Save 90%+ on implementation labor.** Mechanical work runs on cheaper standard agents; your flagship model stays on architecture and decisions.
- **Structural quality.** Implementation and review run on different agents — different training data, different blind spots. Cross-agent review catches what self-review can't.
- **Client-agnostic.** One daemon serves Claude Code, Gemini CLI, Codex CLI, and Cursor via installable skills. The daemon outlives any individual client session.

---

## Quick start

```bash
# 1. install
npm i -g @zhixuan92/multi-model-agent     # requires Node ≥ 22

# 2. write a config (~/.multi-model/config.json) — see Configuration below

# 3. start the daemon
mmagent serve                              # 127.0.0.1:7337 by default

# 4. install skills for your AI client (auto-detect or pick a target)
mmagent install-skill                      # all detected clients
mmagent install-skill --target=claude-code # or gemini / codex / cursor

# 5. verify
curl -s http://localhost:7337/health       # → {"ok":true,"version":"3.5.1",...}
```

Skills are thin adapters that point your AI client at the running daemon. Once installed, the client has the full tool set with no further setup.

For a long-running background install, use a user service ([macOS launchd / Linux systemd templates](./packages/server/scripts/README.md)).

## Supported clients

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

## Configuration

Config file: `~/.multi-model/config.json`. Lookup order: `--config <path>` → `$MMAGENT_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.multi-model/config.json`.

```json
{
  "agents": {
    "standard": { "type": "codex",  "model": "codex-mini-latest" },
    "complex":  { "type": "claude", "model": "claude-sonnet-4-20250514" }
  },
  "defaults": {
    "timeoutMs": 1800000,
    "maxCostUSD": 10,
    "tools": "full"
  },
  "server": {
    "bind": "127.0.0.1",
    "port": 7337,
    "auth": { "tokenFile": "~/.multi-model/auth-token" }
  }
}
```

Agent types: `claude`, `codex`, `openai-compatible`, `claude-compatible`. Any OpenAI-compatible endpoint works (MiniMax, DeepSeek, Groq, Together, local vLLM) — set `baseUrl` and either `apiKey` or `apiKeyEnv`:

```json
{
  "agents": {
    "standard": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY"
    },
    "complex": {
      "type": "openai-compatible",
      "model": "gpt-5",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
```

`claude-compatible` is the same wiring shape (`baseUrl` + `apiKey` / `apiKeyEnv`) for vendors that expose an Anthropic-format endpoint instead — e.g. DeepSeek's `/anthropic`. Use this for thinking-mode reasoning models on third-party hosts: Anthropic's wire format preserves thinking content blocks across multi-turn tool use, which is required for DeepSeek V4's hybrid thinking models to work reliably (the OpenAI Chat Completions wire format strips the non-standard `reasoning_content` field on follow-up turns and 400s):

```json
{
  "agents": {
    "complex": {
      "type": "claude-compatible",
      "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  }
}
```

DeepSeek configured under `openai-compatible` still works — thinking is auto-disabled to keep multi-turn calls from 400ing — but reasoning is sacrificed. Use `claude-compatible` to keep V4's reasoning ON.

The auth token is generated on first `mmagent serve`. Retrieve it with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` to override the file.

## REST API

15 endpoints — full table and request/response shapes in [packages/server/README.md](./packages/server/README.md#rest-api). Tool endpoints are async: they return `202 { batchId, statusUrl }` immediately; poll `GET /batch/:id` for the terminal envelope.

## Operator commands

```bash
mmagent serve [--verbose] [--log]   # start daemon (--verbose → stderr events; --log → JSONL to ~/.multi-model/logs/)
mmagent info  [--json]              # cliVersion, bind/port, token fingerprint, daemon identity (offline)
mmagent status [--json]             # health + stats from a running daemon
mmagent logs  [--follow] [--batch=<id>]   # tail today's diagnostic log
mmagent print-token                 # print the current auth token
mmagent install-skill [--target=<client>] [--all-targets] [--uninstall]
mmagent update-skills [--dry-run] [--json]   # refresh installed skills after upgrade
mmagent telemetry status                    # show consent state + source (env / config / default)
mmagent telemetry enable                    # opt in (writes ~/.multi-model/config.json)
mmagent telemetry disable                   # opt out + delete local queue
mmagent telemetry reset-id                  # rotate the local Ed25519 identity (new install-id next run)
mmagent telemetry dump-queue                # print the locally-queued events as JSON (pre-upload inspection)
```

## Operations

### Upgrading

```bash
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mmagent serve"            # stop the running daemon
mmagent update-skills               # refresh installed skills
# next AI-client session respawns the daemon via the skill preflight
```

A drift warning prints on `mmagent serve` if installed skills are older than the daemon.

### Verbose mode

Enable per-run via `mmagent serve --verbose --log`, or persist in config:

```json
{ "diagnostics": { "log": true, "verbose": true } }
```

Verbose mode emits per-tool, per-LLM-turn, per-stage, and per-batch events. JSONL goes to `~/.multi-model/logs/mmagent-<date>.jsonl`; large request bodies (over 16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`.

**Note:** request bodies may include prompts, file paths, and other task content — disable `verbose` for production servers handling sensitive data.

### Token regeneration

```bash
mmagent print-token                 # show current
rm ~/.multi-model/auth-token        # delete and restart to rotate
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7337 already in use | `lsof -nP -i :7337` → kill the stale process |
| Daemon stale after upgrade | `pkill -f "mmagent serve"`; preflight respawns |
| Skill version mismatch | `mmagent update-skills` and restart your client |
| `401 unauthorized` from a skill | `export MMAGENT_AUTH_TOKEN=$(mmagent print-token)` |

## What's new

Latest: **3.6.4** — Anonymous usage telemetry, **off by default**, now signed end-to-end. When opted in, every upload batch is signed with a per-install Ed25519 key (TOFU; generated on first serve, lives at `~/.multi-model/identity/`); receivers can verify each batch came from the install whose `installId` it claims. Schemas are now `.strict()` so unknown fields fail closed instead of silently leaking. `mmagent telemetry status|enable|disable|reset-id|dump-queue` still gives you full control; nothing leaves your machine until you explicitly opt in. See [PRIVACY.md](./PRIVACY.md) for the exhaustive field-by-field disclosure — nothing personal, no prompts, no file paths.

Full history in [CHANGELOG](./CHANGELOG.md).

## Architecture

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix.
- [DIRECTION.md](./DIRECTION.md) — product north star.
- [packages/core/README.md](./packages/core/README.md) — embedding the runtime as a library (no HTTP server).
- [packages/server/README.md](./packages/server/README.md) — daemon, REST API, and skills detail.

## License

MIT — see [`LICENSE`](./LICENSE).
