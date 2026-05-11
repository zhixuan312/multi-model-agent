# multi-model-agent

[![npm: @zhixuan92/multi-model-agent](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=%40zhixuan92%2Fmulti-model-agent)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)
[![npm: @zhixuan92/multi-model-agent-core](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent-core?label=%40zhixuan92%2Fmulti-model-agent-core)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent-core)

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
mmagent sync-skills                         # auto-detect all clients (idempotent install + update)
# or pin a specific target:
mmagent sync-skills --target=claude-code    # claude-code | gemini-cli | codex-cli | cursor
```

Skills are thin adapters that point your AI client at the running daemon. Once installed, the client has the full tool set with no further setup.

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

### 2. Choose your main model — intentionally (4.0.3+)

Your **main model** is **the model you'd use without mmagent** — the cost baseline for every task. The per-task headline reports `$X actual / $Y saved vs <mainModel> (Z× ROI)`. Pick on purpose:

- Heavy Claude Code user → `claude-opus-4-7`
- ChatGPT-led workflow → `gpt-5.5`
- Gemini-led workflow → `gemini-3.1-pro`

Starting in 4.3.0 the main model is resolved automatically per request:

1. `X-MMA-Main-Model` header (override) — highest priority.
2. Per-client auto-detect — Claude Code reads the latest `~/.claude/projects/<slug>/*.jsonl`; Codex CLI reads `~/.codex/config.toml`.
3. `defaults.mainModel` from `~/.multi-model/config.json` — explicit operator fallback.
4. `unknown_main_model` sentinel — only when nothing above resolves.

Only `X-MMA-Client` remains required on tool routes (the resolver's discriminator). Export it once if you're calling the API directly:

```bash
export MMAGENT_CLIENT=claude-code           # or codex-cli, gemini-cli, cursor
```

### 3. Write the config

Paste this into your shell — it creates `~/.multi-model/config.json` with the minimum-viable starter config (overwrites any existing file at that path):

```bash
mkdir -p ~/.multi-model && cat > ~/.multi-model/config.json <<'EOF'
{
  "agents": {
    "standard": {
      "type": "claude-compatible",
      "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    },
    "complex": {
      "type": "codex",
      "model": "gpt-5.5"
    }
  }
}
EOF
```

That's the whole minimum-viable file. All other knobs (`server.*`, `defaults.timeoutMs`, `defaults.maxCostUSD`, `defaults.tools`, …) have sane built-in defaults — see [Configuration reference](#configuration-reference) for the override table and per-provider auth notes.

> **4.3.0 update:** `X-MMA-Main-Model` is no longer required — see the resolver chain above. `defaults.mainModel` is the explicit operator fallback when neither the header nor per-client auto-detect resolves.

### 4. Start the daemon + verify

Two ways — pick one:

**Option A — let your AI client auto-spawn it.** Just open your client (Claude Code / Codex CLI / etc.) and call any mma-* skill; the skill's preflight check spawns `mmagent serve` on `127.0.0.1:7337` and reuses it for every subsequent call. Nothing else to do.

**Option B — start it manually.** Useful when you want the daemon up before opening a client (e.g. to inspect the queue, run `curl /health`, or attach to logs):

```bash
mmagent serve                          # 127.0.0.1:7337 by default
curl -s http://localhost:7337/health   # → {"ok":true,"version":"4.3.0",...}
```

For a long-running background install (always-on, survives reboots), use [the launchd / systemd templates](./packages/server/scripts/README.md).

## Updating

```bash
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mmagent serve"            # stop the running daemon
mmagent sync-skills                 # reconcile installed skills with the new bundle
# next AI-client session respawns the daemon via the skill preflight
```

A drift warning prints on `mmagent serve` if installed skills are older than the daemon. To rotate the auth token: `rm ~/.multi-model/auth-token && mmagent serve` (a new token is regenerated on boot).

## Skills

Skills are the surface your AI client sees. `mmagent sync-skills` writes the table below into the client's skill index and keeps it reconciled across upgrades; the client then picks the right one based on what you ask. You don't call them by hand — you describe the work, the client routes it.

### Work-delegation skills

| Skill | Use when |
|---|---|
| `mma-delegate` | Ad-hoc implementation or research tasks **without** a plan file — run them in parallel on cheap workers. |
| `mma-execute-plan` | A plan / spec markdown exists on disk with numbered task headings; implement one or more tasks from it. |
| `mma-investigate` | Answer a question about *this* codebase ("how does X work", "where is Y called") without burning main-context tokens on grep + reads. |
| `mma-explore` | Orchestrator playbook — fans out `mma-investigate` + `mma-research` in parallel and synthesises 3–5 distinct directions. Run before `superpowers:brainstorming`. Not for "where is X" questions (use `mma-investigate`). |
| `mma-research` | External multi-source research with citations — arxiv, semantic_scholar, github_search, rss, brave-with-`site:`-filters — for a focused question. |
| `mma-debug` | A test fails, a build breaks, or behavior is unexpected — delegate the reproduce/trace, keep the hypothesis on the main agent. |
| `mma-review` | Source-code review (pre-merge, post-implementation, security-focused). One worker per file, in parallel. |
| `mma-audit` | Audit a spec / plan / design doc / recommendation doc for executability blockers (contradictions, ambiguity, recommendation-coherence gaps). Default is the comprehensive sweep; `security` and `performance` are narrow opt-in lenses. |
| `mma-verify` | Check acceptance criteria against finished work *before* claiming done. One worker per checklist item. |

### Plumbing skills

| Skill | Use when |
|---|---|
| `mma-context-blocks` | The same large doc (>~2 KB) will be referenced by 2+ subsequent mma-* calls — register once, pass the ID instead of re-uploading. |
| `mma-retry` | A previous batch came back partial — re-run only the failed indices without re-dispatching the whole batch. |

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
| `defaults.timeoutMs` | `3600000` (60 min) | Hard task-level wall-clock cap. Per-runner-call timeouts are clamped to remaining budget. Bumped from 30 min in 3.9.0. |
| `defaults.stallTimeoutMs` | `1200000` (20 min) | Aborts in-flight runs that have no LLM / tool / text activity for this long. Force-salvages and returns. Bumped from 10 min in 3.9.0. |
| `defaults.maxCostUSD` | `10` | Hard per-task cost ceiling. Returns `cost_exceeded` when hit. |
| `defaults.tools` | `"full"` | Tool surface: `none` / `readonly` / `no-shell` / `full`. |
| `defaults.sandboxPolicy` | `"cwd-only"` | Path-traversal + symlink confinement to the request's `cwd`. |

### Auth token

Generated on first `mmagent serve`. Retrieve with `mmagent print-token`, or set `MMAGENT_AUTH_TOKEN` to override the file.

### Telemetry

**Off by default.** Opt in via `mmagent telemetry enable` (or `MMAGENT_TELEMETRY=1`), or add the `telemetry` block directly to `~/.multi-model/config.json`:

```json
{
  "agents": { "...": "..." },
  "telemetry": {
    "enabled": true
  }
}
```

When opted in, every upload batch carries one `task.completed` event per task with exact integer counts (tokens, tool calls, files, turns, durations in ms) and cost estimates in USD — no bucketed fields, no session/install/skill events. Batches are signed with a per-install Ed25519 key (TOFU; generated at `~/.multi-model/identity.json`). Full disclosure of every collected field in [PRIVACY.md](./PRIVACY.md).

**V2→V3 upgrade note:** Previous V2 opt-ins are cleared on upgrade to 3.10.0+. Run `mmagent telemetry enable` to opt in to schema v3.

### Verbose / diagnostics

Add the `diagnostics` block to `~/.multi-model/config.json`:

```json
{
  "agents": { "...": "..." },
  "diagnostics": {
    "log": true,
    "verbose": true
  }
}
```

Or per-run via `mmagent serve --verbose --log`. JSONL goes to `~/.multi-model/logs/mmagent-<date>.jsonl`; large request bodies (>16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`.

> **Note:** verbose logs may include prompts, file paths, and other task content — disable for production servers handling sensitive data.

## Operator commands

```bash
mmagent serve [--verbose] [--log]                # start daemon
mmagent info  [--json]                           # cliVersion, bind/port, token fingerprint, daemon identity
mmagent status [--json]                          # health + stats from a running daemon
mmagent logs  [--follow] [--batch=<id>]          # tail today's diagnostic log
mmagent print-token                              # print the current auth token
mmagent sync-skills [--target=<client>] [--all-targets] [--dry-run] [--json]   # idempotent install + update + reconcile
mmagent telemetry status                         # show consent state + source (env / config / default)
mmagent telemetry enable                         # opt in (writes ~/.multi-model/config.json)
mmagent telemetry disable                       # opt out + delete local queue
mmagent telemetry reset-id                      # rotate the local Ed25519 identity (new install-id next run)
mmagent telemetry dump-queue                    # print the locally-queued events as JSON (pre-upload inspection)
```

## Architecture

`mmagent serve` runs a loopback HTTP server exposing 16 REST endpoints. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout. Tool endpoints are async — they return `202 { batchId, statusUrl }` immediately, and you poll `GET /batch/:id` for the terminal envelope.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix
- [packages/server/README.md](./packages/server/README.md#rest-api) — full REST endpoint table + request/response shapes (for custom integrators)
- [DIRECTION.md](./DIRECTION.md) — product north star
- [packages/core/README.md](./packages/core/README.md) — embedding the runtime as a library (no HTTP server)
- [packages/server/README.md](./packages/server/README.md) — daemon, REST API, and skills detail

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7337 already in use | `lsof -nP -i :7337` → kill the stale process |
| Daemon stale after upgrade | `pkill -f "mmagent serve"`; the skill preflight respawns it on next client session |
| Skill version mismatch | `mmagent sync-skills` and restart your client |
| `401 unauthorized` from a skill | `export MMAGENT_AUTH_TOKEN=$(mmagent print-token)` |
| `pkill` reports success but `mmagent info` still shows the old PID | The pattern didn't match — try `kill <pid-from-mmagent-info>` directly |
| TLS `handshake_failure` to a known-good telemetry endpoint | Local DNS cache is stale. `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` (macOS); restart the daemon so its Node process re-resolves |
| Local telemetry queue stops draining | Daemon's flusher is in exponential backoff after a transport failure (capped at 1 hr). Restart the daemon to force an immediate boot-flush |

## What's new in 4.3.0

Major lifecycle redesign + Group A reliability completion:
- **Pipeline rewrite: review (parallel lint) + rework (complex tier, conditional).** Replaces the prior fix-inline reviewer stages. Spec + quality reviewers run in parallel with readonly tools, emit verdicts + deviations; a single rework stage applies fixes when changes are required, skipped when both approve.
- **`X-MMA-Main-Model` header is no longer required.** Resolved automatically per request (header → per-client jsonl/toml → config fallback → sentinel). `X-MMA-Client` remains required.
- **WallClockGuard wired end-to-end.** Per-task budget enforced at every stage entry and tool-call boundary; failures surface as `errorCode: 'guard_wall_clock'` with a well-formed envelope.
- **Context-overflow pre-flight estimator.** Intake refuses dispatches whose estimated tokens exceed the model cap, emitting `context_overflow_predicted` with biggest-contributors + recovery hints before any worker spawns.
- **Plan-audit per-task verdicts.** `auditType: 'plan'` now synthesises EXECUTABLE / PARTIAL / BLOCKED per task and surfaces a "Plan-Audit Summary" with the next blocker.
- **`cwd-validator` ENOENT fix.** Previously every `write_file` to a non-existent path failed silently. Workers can now create new files.

CHANGELOG has the full breakdown.

Full history: [CHANGELOG](./CHANGELOG.md).

## License

MIT — see [`LICENSE`](./LICENSE).
