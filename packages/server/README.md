# @zhixuan92/multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP service for delegating tool-using work to sub-agents on different LLM providers.

*Renamed from `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — the package no longer uses MCP. See [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md#300).*

## Why

- **Save 90%+ on implementation labor.** Mechanical work runs on cheaper standard agents; your flagship model stays on architecture and decisions.
- **Structural quality.** Implementation and review run on different agents — different training data, different blind spots. Cross-agent review catches what self-review can't.
- **Client-agnostic.** One daemon serves Claude Code, Gemini CLI, Codex CLI, and Cursor via installable skills. The daemon outlives any individual client session.

## Install

```bash
npm i -g @zhixuan92/multi-model-agent
```

Requires Node >= 22.

## Run

```bash
mmagent serve   # starts on 127.0.0.1:7337 by default
```

Leave this running in the background, or install as a user service (launchd on macOS, systemd on Linux).

## Install skills for your AI client

```bash
mmagent install-skill                           # auto-detect installed clients
mmagent install-skill --target=claude-code      # or gemini, codex, cursor
mmagent install-skill --all-targets             # install for every detected client
mmagent install-skill --uninstall               # remove skills
```

Skills are thin adapters that point HTTP requests at the running daemon. Once installed, your AI client has the full tool set without further configuration.

## Config

Config file: `~/.multi-model/config.json`

```json
{
  "agents": {
    "standard": { "type": "codex", "model": "codex-mini-latest" },
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

Agent types: `claude`, `codex`, `openai-compatible`. Any OpenAI-compatible endpoint works (MiniMax, DeepSeek, Groq, Together, local vLLM) — set `baseUrl` and either `apiKey` or `apiKeyEnv`.

Config lookup order: `--config <path>` → `$MMAGENT_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.multi-model/config.json`.

The auth token is generated on first `mmagent serve`. Retrieve it with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` in your environment to override the file.

## REST API

The daemon exposes 14 public endpoints. All tool endpoints are async: they return `202 { batchId, statusUrl }` immediately and the executor runs in the background.

| Endpoint | Purpose |
|---|---|
| `POST /delegate?cwd=<abs>` | Fan out ad-hoc tasks to sub-agents |
| `POST /audit?cwd=<abs>` | Audit a document |
| `POST /review?cwd=<abs>` | Review code |
| `POST /verify?cwd=<abs>` | Verify work against a checklist |
| `POST /debug?cwd=<abs>` | Debug a failure with a hypothesis |
| `POST /execute-plan?cwd=<abs>` | Implement from a plan file |
| `POST /retry?cwd=<abs>` | Re-run specific tasks from a previous batch |
| `GET /batch/:id[?taskIndex=N]` | Poll a batch: `202 text/plain` (pending; body is the running headline) or `200 application/json` (terminal; uniform 7-field envelope). `?taskIndex=N` slices on complete state. |
| `POST /context-blocks?cwd=<abs>` | Register a reusable context block |
| `DELETE /context-blocks/:id?cwd=<abs>` | Delete a context block |
| `POST /clarifications/confirm` | Confirm / override a clarification proposal |
| `GET /health` | Liveness probe (unauthenticated, loopback-only) |
| `GET /status` | Server status (authenticated, loopback-only) |
| `GET /tools` | OpenAPI 3 doc for all endpoints (authenticated) |

All tool endpoints require bearer auth: `Authorization: Bearer <token>`.

## Operator commands

```bash
mmagent serve [--verbose] [--log]   # start daemon (--verbose streams per-tool/turn/stage events to stderr; --log persists JSONL to ~/.multi-model/logs/)
mmagent info [--json]               # print cliVersion, bind/port, token fingerprint, daemon identity (works offline)
mmagent status [--json]             # show running daemon health and stats
mmagent logs [--follow] [--batch=<id>]  # tail today's diagnostic log
mmagent print-token                 # print the current auth token
mmagent install-skill               # install all shipped skills (default); pass a skill name to scope to one
mmagent install-skill --uninstall   # remove all installed skills; pass a skill name to scope to one
mmagent update-skills [--dry-run] [--json]  # refresh installed skills from the shipped bundle
```

## Shipped skills

Skills are Markdown prompts that tell your AI client when and how to call each endpoint. `mmagent install-skill` inlines the shared auth/polling patterns at install time.

| Skill | Target endpoint |
|---|---|
| `multi-model-agent` | Overview + skill map |
| `mma-delegate` | `POST /delegate` |
| `mma-audit` | `POST /audit` |
| `mma-review` | `POST /review` |
| `mma-verify` | `POST /verify` |
| `mma-debug` | `POST /debug` |
| `mma-execute-plan` | `POST /execute-plan` |
| `mma-retry` | `POST /retry` |
| `mma-context-blocks` | `POST/DELETE /context-blocks` |
| `mma-clarifications` | `POST /clarifications/confirm` |

## Architecture at a glance

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

Full design rationale: [DIRECTION.md](https://github.com/zhixuan312/multi-model-agent/blob/master/DIRECTION.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
