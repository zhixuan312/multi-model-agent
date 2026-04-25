# @zhixuan92/multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP service for delegating tool-using work to sub-agents on different LLM providers.

*Renamed from `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — the package no longer uses MCP. See [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md#300).*

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
curl -s http://localhost:7337/health       # → {"ok":true,"version":"3.4.0",...}
```

Skills are thin adapters that point your AI client at the running daemon. Once installed, the client has the full tool set with no further setup.

For a long-running background install, use a user service ([macOS launchd / Linux systemd templates](./scripts/README.md)).

## Configuration

Config file: `~/.multi-model/config.json`. Lookup order: `--config <path>` → `$MMAGENT_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.multi-model/config.json`.

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

The auth token is generated on first `mmagent serve`. Retrieve it with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` to override the file.

## REST API

15 endpoints. All tool endpoints are async: they return `202 { batchId, statusUrl }` immediately and the executor runs in the background. Poll `GET /batch/:id` for the terminal envelope.

| Endpoint | Purpose |
|---|---|
| `POST /delegate?cwd=<abs>` | Fan out ad-hoc tasks to sub-agents |
| `POST /audit?cwd=<abs>` | Audit a document |
| `POST /review?cwd=<abs>` | Review code |
| `POST /verify?cwd=<abs>` | Verify work against a checklist |
| `POST /debug?cwd=<abs>` | Debug a failure with a hypothesis |
| `POST /execute-plan?cwd=<abs>` | Implement from a plan file |
| `POST /retry?cwd=<abs>` | Re-run specific tasks from a previous batch |
| `POST /investigate?cwd=<abs>` | Codebase Q&A — structured answer with file:line citations + confidence |
| `GET /batch/:id[?taskIndex=N]` | Poll a batch: `202 text/plain` (pending; body is the running headline) or `200 application/json` (terminal; uniform 7-field envelope). `?taskIndex=N` slices on complete state. |
| `POST /context-blocks?cwd=<abs>` | Register a reusable context block |
| `DELETE /context-blocks/:id?cwd=<abs>` | Delete a context block |
| `POST /clarifications/confirm` | Confirm / override a clarification proposal |
| `GET /health` | Liveness probe (unauthenticated, loopback-only) |
| `GET /status` | Server status (authenticated, loopback-only) |
| `GET /tools` | OpenAPI 3 doc for all endpoints (authenticated) |

All tool endpoints require bearer auth: `Authorization: Bearer <token>`.

## What's new in 3.5.1

**Bug fixes:**
- **Single-provider deployments no longer burn a doomed cross-tier fallback call.** When `agents.standard` and `agents.complex` resolve to the same backend (one-provider deployment) and the assigned-tier call transport-fails, the wrapper used to substitute to the alt tier — which in that configuration just hits the same backend, burning a second doomed call and surfacing as `terminationReason: 'all_tiers_unavailable'`. The original failure now flows through as the task's terminal result with the actual root-cause status. No new operator config; auto-detected via deep-equal of the effective provider config.
- **No more `runner_crash: verbose-line: invalid key name` on fallback / rework paths.** With `diagnostics.verbose: true`, any run that hit fallback / escalation / spec_rework / quality_rework previously threw inside the verbose-stream serializer (camelCase event-param keys like `assignedTier`, `implTier`, `attemptCap` violated its snake_case-only validator) and surfaced as terminal `runner_crash` even though the model itself succeeded. The verbose-stream branch now drops `batchId` / `taskIndex` (already emitted as `batch` / `task`) and snake-cases the remaining keys; the JSONL `DiagnosticLogger` contract (camelCase `assignedTier` / `implTier` / ... on `escalation` / `fallback` events) is unchanged.

## What's new in 3.5.0

**Breaking changes (operators read this first):**
- `task.maxReviewRounds` is gone — review caps now derive from policy tables (`maxReworksFor('spec') = 2`, `maxReworksFor('quality') = 2`). Remove the field from any callers.
- `agentType` is gone from `/execute-plan` (top-level + per-task). The compiler hardcodes `agentType: 'standard'`. `/delegate` is unchanged and still accepts the field.
- Status-level escalation inside `delegateWithEscalation` is removed. Transport failures now flow through the new `runWithFallback` wrapper in `reviewed-lifecycle.ts`.

**New behavior:**
- **Tier-escalating rework.** For standard-tier tasks, the implementation tier escalates to complex on the final rework attempt; reviewers swap to keep impl ≠ reviewer.
- **Runtime tier fallback.** Transport failures (`api_error` / `network_error` / `timeout`) or missing configuration trigger automatic substitution of the other tier. Fallback is sticky per loop.
- **Single-slot operators** receive reviews on the same tier (`violatesSeparation: true`); set `reviewPolicy: 'off'` to opt out.
- **Four new diagnostic events** — `escalation`, `escalation_unavailable`, `fallback`, `fallback_unavailable` — emitted via the verbose stderr stream and JSONL log.
- **New `agents.*History` and `agents.fallbackOverrides`** envelope fields surface tier movement; the headline composer adds `(escalated to complex; fallback fired)` style suffixes.

## Operator commands

```bash
mmagent serve [--verbose] [--log]         # start daemon (--verbose → stderr events; --log → JSONL to ~/.multi-model/logs/)
mmagent info  [--json]                    # cliVersion, bind/port, token fingerprint, daemon identity (offline)
mmagent status [--json]                   # health + stats from a running daemon
mmagent logs  [--follow] [--batch=<id>]   # tail today's diagnostic log
mmagent print-token                       # print the current auth token
mmagent install-skill [--target=<client>] [--all-targets] [--uninstall]   # default installs all shipped skills
mmagent update-skills [--dry-run] [--json]   # refresh installed skills after upgrade
```

## Shipped skills

Skills are Markdown prompts that tell your AI client when and how to call each endpoint. `mmagent install-skill` inlines the shared auth/polling patterns at install time.

| Skill | Target endpoint |
|---|---|
| `multi-model-agent` | Overview + skill map (read first to pick the right `mma-*` skill) |
| `mma-delegate` | `POST /delegate` |
| `mma-audit` | `POST /audit` |
| `mma-review` | `POST /review` |
| `mma-verify` | `POST /verify` |
| `mma-debug` | `POST /debug` |
| `mma-execute-plan` | `POST /execute-plan` |
| `mma-retry` | `POST /retry` |
| `mma-investigate` | `POST /investigate` |
| `mma-context-blocks` | `POST/DELETE /context-blocks` |
| `mma-clarifications` | `POST /clarifications/confirm` |

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

JSONL goes to `~/.multi-model/logs/mmagent-<date>.jsonl`. Large request bodies (over 16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`. **Note:** request bodies may include prompts and file paths — disable `verbose` for production servers handling sensitive data.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7337 already in use | `lsof -nP -i :7337` → kill the stale process |
| Daemon stale after upgrade | `pkill -f "mmagent serve"`; preflight respawns |
| Skill version mismatch | `mmagent update-skills` and restart your client |
| `401 unauthorized` from a skill | `export MMAGENT_AUTH_TOKEN=$(mmagent print-token)` |

## Architecture at a glance

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

Full design rationale: [DIRECTION.md](https://github.com/zhixuan312/multi-model-agent/blob/master/DIRECTION.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
