# multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Delegate the labor, keep the judgment. Your flagship model stays on architecture and decisions — mechanical work runs on a fleet of cheaper agents, in parallel, for 90%+ less.

A local HTTP daemon for Claude Code, Codex CLI, Gemini CLI, and Cursor. One tool call dispatches tasks across any mix of models — auto-routed, cost-bounded, cross-agent reviewed.

*(Replaced `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — see [CHANGELOG](./CHANGELOG.md).)*

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste. multi-model-agent fixes this.

- **Save 90%+ on implementation labor.** Mechanical work runs on standard agents at **$0.01–0.03/task**. Spec/quality review runs on complex agents at **$0.30–0.65/task**. Your flagship model does neither.
- **Keep your context window clean.** Every task runs in an isolated worker context. Zero implementation tokens pollute your architect session.
- **Ship faster with parallelism.** Independent tasks execute concurrently — 30–45% wall-clock savings on multi-file work.
- **Catch bugs with cross-agent review.** Implementation and review run on different model families. Different training data, different blind spots — structural quality you can't get from self-review.

| Project | MMA — MiniMax-M2.7 | MMA — DeepSeek V4 Pro | Flagship: Claude Opus 4.7 |
|---|---|---|---|
| Feature impl (30 files, ~50 tasks) | **$1.50** · **33× ROI** · ~35 min | **~$2.50** · **20× ROI** · ~15 min | $50 · 1× · *baseline* |
| Full web SPA (59 tasks) | **$5.65** · **12× ROI** · ~50 min | **~$9** · **7.5× ROI** · ~22 min | $68 · 1× · *baseline* |
| Backend microservice (91 tasks) | **$8.21** · **13× ROI** · ~1.5 hrs | **~$14** · **7.5× ROI** · ~40 min | $104 · 1× · *baseline* |

## Initial setup

Four steps, in order.

### 1. Install CLI + skills

```bash
npm i -g @zhixuan92/multi-model-agent       # requires Node ≥ 22
mmagent install-skill                       # auto-detect all clients
# or pin a specific target:
mmagent install-skill --target=claude-code  # claude-code | gemini-cli | codex-cli | cursor
```

Skills are thin adapters that point your AI client at the running daemon. Once installed, the client has the full tool set with no further setup.

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

### 2. Choose your parent model — intentionally

`defaults.parentModel` is **the model you'd use without mmagent**. mmagent treats it as the cost baseline for every task: the per-task headline reports `$X actual / $Y saved vs <parentModel> (Z× ROI)`. Leave it unset and you lose the savings/ROI signal. Pick on purpose:

- Heavy Claude Code user → `claude-opus-4-7`
- ChatGPT-led workflow → `gpt-5.5`
- Gemini-led workflow → `gemini-3.1-pro`

### 3. Write the config

`~/.multi-model/config.json` — minimal, recommended:

```json
{
  "agents": {
    "standard": {
      "type": "openai-compatible",
      "model": "MiniMax-M2.7",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY"
    },
    "complex": {
      "type": "codex",
      "model": "gpt-5.5"
    }
  },
  "defaults": {
    "parentModel": "claude-opus-4-7"
  }
}
```

That's the whole minimum-viable file. All other knobs (`server.*`, `defaults.timeoutMs`, `defaults.maxCostUSD`, `defaults.tools`, …) have sane built-in defaults — see [Configuration reference](#configuration-reference) for the override table and per-provider auth notes.

### 4. Start the daemon + verify

Two ways — pick one:

**Option A — let your AI client auto-spawn it.** Just open your client (Claude Code / Codex CLI / etc.) and call any mma-* skill; the skill's preflight check spawns `mmagent serve` on `127.0.0.1:7337` and reuses it for every subsequent call. Nothing else to do.

**Option B — start it manually.** Useful when you want the daemon up before opening a client (e.g. to inspect the queue, run `curl /health`, or attach to logs):

```bash
mmagent serve                          # 127.0.0.1:7337 by default
curl -s http://localhost:7337/health   # → {"ok":true,"version":"3.6.4",...}
```

For a long-running background install (always-on, survives reboots), use [the launchd / systemd templates](./packages/server/scripts/README.md).

## Updating

```bash
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mmagent serve"            # stop the running daemon
mmagent update-skills               # refresh installed skills
# next AI-client session respawns the daemon via the skill preflight
```

A drift warning prints on `mmagent serve` if installed skills are older than the daemon. To rotate the auth token: `rm ~/.multi-model/auth-token && mmagent serve` (a new token is regenerated on boot).

## Configuration reference

### Lookup order

`--config <path>` → `$MMAGENT_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.multi-model/config.json`.

### Agent types

| Type | Auth | When to pick |
|---|---|---|
| `claude` | Local Claude Code OAuth (`claude login`) | Stay on Claude end-to-end with subscription auth |
| `codex` | Codex CLI subscription (`codex login`) | OpenAI flagship work without juggling API keys |
| `openai-compatible` | `apiKey` or `apiKeyEnv` | Any OpenAI-compatible endpoint — MiniMax, Groq, Together, local vLLM, plus OpenAI direct |
| `claude-compatible` | `apiKey` or `apiKeyEnv` | Vendors exposing an Anthropic-format endpoint (DeepSeek's `/anthropic`, etc.) — preserves thinking content blocks across multi-turn tool use, required for thinking-mode reasoning models |

DeepSeek V4 Pro under `claude-compatible` keeps reasoning ON; the same model under `openai-compatible` works but auto-disables thinking (its `reasoning_content` field is non-standard for Chat Completions and would 400 on multi-turn).

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

### Tuning

Every `defaults` knob has a sane built-in. Override only when you have a reason.

| Field | Default | What it does |
|---|---|---|
| `defaults.timeoutMs` | `1800000` (30 min) | Hard task-level wall-clock cap. Per-runner-call timeouts are clamped to remaining budget. |
| `defaults.stallTimeoutMs` | `600000` (10 min) | Aborts in-flight runs that have no LLM / tool / text activity for this long. Force-salvages and returns. |
| `defaults.maxCostUSD` | `10` | Hard per-task cost ceiling. Returns `cost_exceeded` when hit. |
| `defaults.tools` | `"full"` | Tool surface: `none` / `readonly` / `no-shell` / `full`. |
| `defaults.sandboxPolicy` | `"cwd-only"` | Path-traversal + symlink confinement to the request's `cwd`. |
| `defaults.parentModel` | *(none)* | Cost baseline for the per-task ROI headline. **Set this on purpose.** |

### Auth token

Generated on first `mmagent serve`. Retrieve with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` to override the file.

### Telemetry

**Off by default.** Opt in via `mmagent telemetry enable` (or `MMAGENT_TELEMETRY=1`), or add the `telemetry` block directly to `~/.multi-model/config.json`:

```json
{
  "agents": { "...": "..." },
  "defaults": { "parentModel": "claude-opus-4-7" },
  "telemetry": {
    "enabled": true
  }
}
```

When opted in, every upload batch is signed with a per-install Ed25519 key (TOFU; generated at `~/.multi-model/identity.json`); receivers can verify the batch came from the install whose `installId` it claims. Full disclosure of every collected field in [PRIVACY.md](./PRIVACY.md).

### Verbose / diagnostics

Add the `diagnostics` block to `~/.multi-model/config.json`:

```json
{
  "agents": { "...": "..." },
  "defaults": { "parentModel": "claude-opus-4-7" },
  "diagnostics": {
    "log": true,
    "verbose": true
  }
}
```

Or per-run via `mmagent serve --verbose --log`. JSONL goes to `~/.multi-model/logs/mmagent-<date>.jsonl`; large request bodies (>16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`.

> **Note:** verbose logs may include prompts, file paths, and other task content — disable for production servers handling sensitive data.

## REST API

15 endpoints. Tool endpoints are async: they return `202 { batchId, statusUrl }` immediately; poll `GET /batch/:id` for the terminal envelope. Full table and request/response shapes in [packages/server/README.md](./packages/server/README.md#rest-api).

## Operator commands

```bash
mmagent serve [--verbose] [--log]                # start daemon
mmagent info  [--json]                           # cliVersion, bind/port, token fingerprint, daemon identity
mmagent status [--json]                          # health + stats from a running daemon
mmagent logs  [--follow] [--batch=<id>]          # tail today's diagnostic log
mmagent print-token                              # print the current auth token
mmagent install-skill [--target=<client>] [--all-targets] [--uninstall]
mmagent update-skills [--dry-run] [--json]      # refresh installed skills after upgrade
mmagent telemetry status                         # show consent state + source (env / config / default)
mmagent telemetry enable                         # opt in (writes ~/.multi-model/config.json)
mmagent telemetry disable                       # opt out + delete local queue
mmagent telemetry reset-id                      # rotate the local Ed25519 identity (new install-id next run)
mmagent telemetry dump-queue                    # print the locally-queued events as JSON (pre-upload inspection)
```

## Architecture

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix
- [DIRECTION.md](./DIRECTION.md) — product north star
- [packages/core/README.md](./packages/core/README.md) — embedding the runtime as a library (no HTTP server)
- [packages/server/README.md](./packages/server/README.md) — daemon, REST API, and skills detail

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7337 already in use | `lsof -nP -i :7337` → kill the stale process |
| Daemon stale after upgrade | `pkill -f "mmagent serve"`; the skill preflight respawns it on next client session |
| Skill version mismatch | `mmagent update-skills` and restart your client |
| `401 unauthorized` from a skill | `export MMAGENT_AUTH_TOKEN=$(mmagent print-token)` |
| `pkill` reports success but `mmagent info` still shows the old PID | The pattern didn't match — try `kill <pid-from-mmagent-info>` directly |
| TLS `handshake_failure` to a known-good telemetry endpoint | Local DNS cache is stale. `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` (macOS); restart the daemon so its Node process re-resolves |
| Local telemetry queue stops draining | Daemon's flusher is in exponential backoff after a transport failure (capped at 1 hr). Restart the daemon to force an immediate boot-flush |

## What's new

Latest: **3.6.4** — Anonymous usage telemetry, **off by default**, now signed end-to-end. Per-install Ed25519 key (TOFU) signs every upload batch; strict schemas fail closed on unknown fields. Full disclosure: [PRIVACY.md](./PRIVACY.md). Full history in [CHANGELOG](./CHANGELOG.md).

## License

MIT — see [`LICENSE`](./LICENSE).
