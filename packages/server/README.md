# @zhixuan92/multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP daemon that delegates tool-using work to sub-agents on different LLM providers. One process serves Claude Code, Codex CLI, Gemini CLI, and Cursor via installable skills.

*Renamed from `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — the package no longer uses MCP. See [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md).*

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste.

| Project | MMA — MiniMax-M2.7 | MMA — DeepSeek V4 Pro | Flagship: Claude Opus 4.7 |
|---|---|---|---|
| Feature impl (30 files, ~50 tasks) | **$1.50** · **33× ROI** · ~35 min | **~$2.50** · **20× ROI** · ~15 min | $50 · 1× · *baseline* |
| Full web SPA (59 tasks) | **$5.65** · **12× ROI** · ~50 min | **~$9** · **7.5× ROI** · ~22 min | $68 · 1× · *baseline* |
| Backend microservice (91 tasks) | **$8.21** · **13× ROI** · ~1.5 hrs | **~$14** · **7.5× ROI** · ~40 min | $104 · 1× · *baseline* |

Plus structural quality: implementation and review run on **different** model families — different blind spots, catches what self-review can't.

## Initial setup

Four steps, in order.

### 1. Install CLI + skills

```bash
npm i -g @zhixuan92/multi-model-agent       # requires Node ≥ 22
mmagent install-skill                       # auto-detect all clients
# or pin a specific target:
mmagent install-skill --target=claude-code  # claude-code | gemini-cli | codex-cli | cursor
```

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

### 2. Choose your parent model — intentionally

`defaults.parentModel` is **the model you'd use without mmagent**. It's the cost baseline for every per-task headline (`$X actual / $Y saved vs <parentModel> (Z× ROI)`). Leave it unset and you lose the savings/ROI signal.

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

That's the whole minimum-viable file. All other knobs (`server.*`, `defaults.timeoutMs`, `defaults.maxCostUSD`, `defaults.tools`, …) have sane built-in defaults — see [Configuration reference](#configuration-reference).

### 4. Start the daemon + verify

Two ways — pick one:

**Option A — let your AI client auto-spawn it.** Open your client (Claude Code / Codex CLI / etc.) and call any mma-* skill; the skill's preflight check spawns `mmagent serve` on `127.0.0.1:7337` and reuses it for every subsequent call.

**Option B — start it manually.** Useful when you want the daemon up before opening a client:

```bash
mmagent serve                          # 127.0.0.1:7337 by default
curl -s http://localhost:7337/health   # → {"ok":true,"version":"3.8.0",...}
```

For an always-on background install (survives reboots): [launchd / systemd templates](./scripts/README.md).

## Updating

```bash
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mmagent serve"            # stop the running daemon
mmagent update-skills               # refresh installed skills
# next AI-client session respawns the daemon via the skill preflight
```

A drift warning prints on `mmagent serve` if installed skills are older than the daemon. To rotate the auth token: `rm ~/.multi-model/auth-token && mmagent serve`.

## Skills

Skills are the surface your AI client sees. `mmagent install-skill` writes them to the client's skill directory; the client then picks the right one based on what you ask. You don't call them by hand — you describe the work, the client routes it to the matching skill, the skill calls the matching REST endpoint.

### Work-delegation skills

| Skill | Target endpoint | Use when |
|---|---|---|
| `mma-delegate` | `POST /delegate` | Ad-hoc implementation or research tasks **without** a plan file — run them in parallel on cheap workers. |
| `mma-execute-plan` | `POST /execute-plan` | A plan / spec markdown exists on disk with numbered task headings; implement one or more tasks from it. |
| `mma-investigate` | `POST /investigate` | Answer a question about *this* codebase ("how does X work", "where is Y called") without burning main-context tokens on grep + reads. |
| `mma-debug` | `POST /debug` | A test fails, a build breaks, or behavior is unexpected — delegate the reproduce/trace, keep the hypothesis on the main agent. |
| `mma-review` | `POST /review` | Source-code review (pre-merge, post-implementation, security-focused). One worker per file, in parallel. |
| `mma-audit` | `POST /audit` | Audit a prose document — spec, config, PR description — for correctness, security, or style. |
| `mma-verify` | `POST /verify` | Check acceptance criteria against finished work *before* claiming done. One worker per checklist item. |

### Plumbing skills

| Skill | Target endpoint | Use when |
|---|---|---|
| `mma-context-blocks` | `POST/DELETE /context-blocks` | The same large doc (>~2 KB) will be referenced by 2+ subsequent mma-* calls — register once, pass the ID instead of re-uploading. |
| `mma-clarifications` | `POST /clarifications/confirm` | A previous batch's terminal envelope returned a `proposedInterpretation` string — the service is paused waiting for you to confirm or correct its read. |
| `mma-retry` | `POST /retry` | A previous batch came back partial — re-run only the failed indices without re-dispatching the whole batch. |

The `multi-model-agent` skill (no `mma-` prefix) is a top-level overview your client reads first to pick which `mma-*` skill applies.

### Two generic usage samples

**Sample 1 — implement a feature from a plan**

```
You: "Execute tasks 3, 4, and 5 from docs/plans/auth-rewrite.md"
↓
Client picks mma-execute-plan (plan file on disk, multiple independent tasks)
↓
mmagent dispatches 3 workers in parallel on the standard agent (e.g. MiniMax-M2.7),
each runs cross-agent review on the complex agent, returns a structured report.
↓
You see one consolidated headline: "$0.04 actual / $1.20 saved vs claude-opus-4-7 (30× ROI)"
```

**Sample 2 — debug a failing test (multiple skills chained)**

```
You: "tests/auth/session.test.ts is failing intermittently after the token-refresh refactor — figure it out and fix it"
↓
Step 1 — mma-context-blocks
  The failing test output + the refactor diff are ~8 KB and will be referenced by every
  downstream call. Register once, get a contextBlockId, reuse it.
↓
Step 2 — mma-debug
  Worker reproduces the failure, traces across session.ts + token-refresh.ts, returns a
  root-cause hypothesis: "race between refresh-in-flight and session.invalidate()".
  Main agent stays on the hypothesis, decides the fix shape.
↓
Step 3 — mma-delegate
  Dispatch the actual code change as an ad-hoc task (no plan file). Worker writes the
  fix, runs the failing test 20× to confirm the race is gone.
↓
Step 4 — mma-verify
  One worker per acceptance criterion: (a) failing test now passes, (b) no other
  auth tests regressed, (c) refresh path still emits the expected telemetry.
↓
Total cost: ~$0.08. Main-context tokens consumed: just the hypotheses and the verdicts.
```

## Configuration reference

### Lookup order

`--config <path>` → `$MMAGENT_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.multi-model/config.json`.

### Agent types

| Type | Auth | When to pick |
|---|---|---|
| `claude` | Local Claude Code OAuth (`claude login`) | Stay on Claude end-to-end with subscription auth |
| `codex` | Codex CLI subscription (`codex login`) | OpenAI flagship work without juggling API keys |
| `openai-compatible` | `apiKey` or `apiKeyEnv` | Any OpenAI-compatible endpoint — MiniMax, Groq, Together, local vLLM, plus OpenAI direct |
| `claude-compatible` | `apiKey` or `apiKeyEnv` | Vendors exposing an Anthropic-format endpoint (DeepSeek's `/anthropic`, etc.) — preserves thinking content blocks across multi-turn tool use |

DeepSeek V4 Pro under `claude-compatible` keeps reasoning ON; under `openai-compatible` it works but auto-disables thinking.

### Tuning

Every `defaults` knob has a built-in. Override only when you need to.

| Field | Default | What it does |
|---|---|---|
| `defaults.timeoutMs` | `1800000` (30 min) | Hard task-level wall-clock cap |
| `defaults.stallTimeoutMs` | `600000` (10 min) | Aborts in-flight runs idle for this long |
| `defaults.maxCostUSD` | `10` | Hard per-task cost ceiling; returns `cost_exceeded` when hit |
| `defaults.tools` | `"full"` | Tool surface: `none` / `readonly` / `no-shell` / `full` |
| `defaults.sandboxPolicy` | `"cwd-only"` | Path-traversal + symlink confinement to the request's `cwd` |
| `defaults.parentModel` | *(none)* | Cost baseline for the per-task ROI headline. **Set this on purpose.** |

### Telemetry

**Off by default.** Opt in via `mmagent telemetry enable` (or `MMAGENT_TELEMETRY=1`), or set in config:

```json
{
  "agents": { "...": "..." },
  "telemetry": { "enabled": true }
}
```

Every upload batch is signed with a per-install Ed25519 key (TOFU; lives at `~/.multi-model/identity.json`); receivers can verify it came from the install whose `installId` it claims. Full disclosure: [PRIVACY.md](https://github.com/zhixuan312/multi-model-agent/blob/master/PRIVACY.md).

### Verbose / diagnostics

```json
{
  "agents": { "...": "..." },
  "diagnostics": { "log": true, "verbose": true }
}
```

Or per-run via `mmagent serve --verbose --log`. JSONL goes to `~/.multi-model/logs/mmagent-<date>.jsonl`; large request bodies (>16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`.

> **Note:** verbose logs may include prompts, file paths, and other task content — disable for production servers handling sensitive data.

### Auth token

Generated on first `mmagent serve`. Retrieve with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` to override.

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
| `GET /batch/:id[?taskIndex=N]` | Poll a batch: `202 text/plain` (pending) or `200 application/json` (terminal). `?taskIndex=N` slices on complete state |
| `POST /context-blocks?cwd=<abs>` | Register a reusable context block |
| `DELETE /context-blocks/:id?cwd=<abs>` | Delete a context block |
| `POST /clarifications/confirm` | Confirm / override a clarification proposal |
| `GET /health` | Liveness probe (unauthenticated, loopback-only) |
| `GET /status` | Server status (authenticated, loopback-only) |
| `GET /tools` | OpenAPI 3 doc for all endpoints (authenticated) |

All tool endpoints require bearer auth: `Authorization: Bearer <token>`.

## Operator commands

```bash
mmagent serve [--verbose] [--log]                # start daemon
mmagent info  [--json]                           # cliVersion, bind/port, token fingerprint, daemon identity
mmagent status [--json]                          # health + stats from a running daemon
mmagent logs  [--follow] [--batch=<id>]          # tail today's diagnostic log
mmagent print-token                              # print the current auth token
mmagent install-skill [--target=<client>] [--all-targets] [--uninstall]
mmagent update-skills [--dry-run] [--json]       # refresh installed skills after upgrade
mmagent telemetry status                         # show consent state + source
mmagent telemetry enable                         # opt in
mmagent telemetry disable                        # opt out + delete local queue
mmagent telemetry reset-id                       # rotate the local Ed25519 identity
mmagent telemetry dump-queue                     # print the locally-queued events as JSON
```

## Architecture

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

Full design rationale: [DIRECTION.md](https://github.com/zhixuan312/multi-model-agent/blob/master/DIRECTION.md). Layer map and request lifecycle: [docs/ARCHITECTURE.md](https://github.com/zhixuan312/multi-model-agent/blob/master/docs/ARCHITECTURE.md).

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

Latest: **3.8.0** — read-only reviewed lifecycle: all 5 read-only routes (audit, review, verify, investigate, debug) now run a single `quality_only` review with bounded rework, structured `findings[]` worker output, and forced cross-tier review (worker complex, reviewer standard). Verify worker tier upgraded to complex. `MMAGENT_READ_ONLY_REVIEW` kill switch for rollback. Full history: [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
