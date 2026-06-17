<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/logo-navy.svg">
    <img src="./assets/logo-navy.svg" alt="MMA Logo" width="120">
  </picture>
</p>

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

| Project | MMA — MiniMax-M3 | MMA — DeepSeek V4 Pro | Flagship: Claude Opus 4.8 |
|---|---|---|---|
| Feature impl (30 files, ~50 tasks) | **$1.50** · **33× ROI** · ~35 min | **~$2.50** · **20× ROI** · ~15 min | $50 · 1× · *baseline* |
| Full web SPA (59 tasks) | **$5.65** · **12× ROI** · ~50 min | **~$9** · **7.5× ROI** · ~22 min | $68 · 1× · *baseline* |
| Backend microservice (91 tasks) | **$8.21** · **13× ROI** · ~1.5 hrs | **~$14** · **7.5× ROI** · ~40 min | $104 · 1× · *baseline* |

## Initial setup

Four steps, in order.

### 1. Install CLI + skills

```bash
npm i -g @zhixuan92/multi-model-agent       # requires Node ≥ 22
mma sync-skills                         # auto-detect all clients (idempotent install + update)
# or pin a specific target:
mma sync-skills --target=claude-code    # claude-code | gemini-cli | codex-cli | cursor
```

Skills are thin adapters that point your AI client at the running daemon. Once installed, the client has the full tool set with no further setup.

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

### 2. Choose your main model — intentionally (4.0.3+)

Your **main model** is **the model you'd use without mma** — the cost baseline for every task. The per-task headline reports `$X actual / $Y saved vs <mainModel> (Z× ROI)`. Pick on purpose:

- Heavy Claude Code user → `claude-opus-4-8`
- ChatGPT-led workflow → `gpt-5.5`
- Gemini-led workflow → `gemini-3.1-pro`

Both `X-MMA-Client` and `X-MMA-Main-Model` are required on tool routes (server returns `400 client_required` / `400 main_model_required` if missing). The 4.3.0 auto-detect chain was reverted in 4.4.0 — the claude-agent-sdk used by claude-tier workers writes JSONL files into the same `~/.claude/projects/<slug>/` the resolver was reading, so auto-detect could return the *worker's* model as the calling agent's "main" model. The calling client is the only reliable source. Export both once if you're calling the API directly:

```bash
export MMA_CLIENT=claude-code              # or codex-cli, gemini-cli, cursor
export MMA_MAIN_MODEL=claude-opus-4-8      # whatever your calling agent runs on
```

### 3. Write the config

Paste this into your shell — it creates `~/.mma/config.json` with the minimum-viable starter config (overwrites any existing file at that path):

```bash
mkdir -p ~/.mma && cat > ~/.mma/config.json <<'EOF'
{
  "agents": {
    "standard": {
      "type": "claude",
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

That's the whole minimum-viable file. All other knobs (`server.*`, `defaults.mainModel`, …) have sane built-in defaults — see [Configuration reference](#configuration-reference) for the override table and per-provider auth notes.

### 4. Start the daemon + verify

Two ways — pick one:

**Option A — let your AI client auto-spawn it.** Just open your client (Claude Code / Codex CLI / etc.) and call any mma-* skill; the skill's preflight check spawns `mma serve` on `127.0.0.1:7337` and reuses it for every subsequent call. Nothing else to do.

**Option B — start it manually.** Useful when you want the daemon up before opening a client (e.g. to inspect the queue, run `curl /health`, or attach to logs):

```bash
mma serve                          # 127.0.0.1:7337 by default
curl -s http://localhost:7337/health   # → {"status":"ok"}
```

For a long-running background install (always-on, survives reboots), use [the launchd / systemd templates](./packages/server/scripts/README.md).

## Updating

```bash
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mma serve"            # stop the running daemon
mma sync-skills                 # reconcile installed skills with the new bundle
# next AI-client session respawns the daemon via the skill preflight
```

A drift warning prints on `mma serve` if installed skills are older than the daemon. To rotate the auth token: `rm ~/.mma/auth-token && mma serve` (a new token is regenerated on boot).

## Disabling / re-enabling

To turn MMA off without uninstalling the package — e.g. for a sensitive repo you don't want delegated to external models, or to compare behaviour with and without it:

```bash
mma disable        # removes the skills from every detected client; your AI stops routing to MMA
mma enable         # restores them
```

`disable` is **sticky**: it records a sentinel at `~/.mma/skills-disabled.json` that `sync-skills` (including the `npm install` postinstall hook) honours, so an upgrade won't silently reinstall the skills. Scope it per client with `--target=<client>`, or preview with `--dry-run`. `enable` clears the sentinel and runs the normal `sync-skills` upsert; a bare `enable` restores every client that was turned off, including any scoped with `--target`.

A bare `mma disable` covers the auto-detected clients (claude-code, codex). Cursor and Gemini are only touched when named explicitly (`--target=cursor` / `--all-targets`). **Cursor skills are project-local**: `disable --target=cursor` removes them from the current working directory only, but the off-pin is global, so future `sync-skills` runs stay blocked for cursor everywhere until you `enable`. Re-run `enable --target=cursor` from each cursor project to reinstall its skills there.

## Skills

Skills are the surface your AI client sees. `mma sync-skills` writes the table below into the client's skill index and keeps it reconciled across upgrades; the client then picks the right one based on what you ask. You don't call them by hand — you describe the work, the client routes it.

### Work-delegation skills

| Skill | Use when |
|---|---|
| `mma-delegate` | Ad-hoc implementation or research tasks **without** a plan file — run them on cheap workers as one goal-set (implement → review-fix). |
| `mma-execute-plan` | A plan / spec markdown exists on disk with numbered task headings; implement one or more tasks from it. |
| `mma-investigate` | Answer a question about *this* codebase ("how does X work", "where is Y called") without burning main-context tokens on grep + reads. |
| `mma-explore` | Orchestrator playbook — fans out `mma-investigate` + `mma-research` + `mma-journal-recall` in parallel and synthesises 3–5 distinct directions. Run before `superpowers:brainstorming`. Not for "where is X" questions (use `mma-investigate`). |
| `mma-research` | External multi-source research with citations — arxiv, semantic_scholar, github_search, openalex, crossref, pubmed, brave-with-freshness/news/`site:`-filters — for a focused question. |
| `mma-debug` | A test fails, a build breaks, or behavior is unexpected — delegate the reproduce/trace, keep the hypothesis on the main agent. |
| `mma-review` | Source-code review (pre-merge, post-implementation, security-focused). One worker per file, in parallel. |
| `mma-audit` | Audit a spec / plan / design doc / skill file for executability blockers (contradictions, ambiguity, recommendation-coherence gaps). Subtypes: `default` (prose-coherence), `plan` (code-execution plan vs codebase), `spec` (requirement testability + decision trace), `skill` (skill file reader-effectiveness). |
| `mma-journal-record` | Record a durable project learning into the cross-agent journal — what was tried, what happened, the lesson — integrated into a graph of ADR "node" files under `.mma/journal/` (create / refine / supersede / merge with typed edges). |
| `mma-journal-recall` | Recall relevant prior learnings from the journal for a question or situation — traverses the node graph rather than keyword-filtering. |

### Plumbing skills

| Skill | Use when |
|---|---|
| `mma-context-blocks` | The same large doc (>~2 KB) will be referenced by 2+ subsequent mma-* calls — register once, pass the ID instead of re-uploading. |
| `mma-orchestrate` | A multi-phase workflow needs a session-persistent LLM brain for orchestration — send a structured prompt, get a structured response, reuse the session across workflow phases. Uses the `main` tier (no reviewer, no worktree). |
| `mma-retry` | A previous dispatch came back partial — re-run only the failed indices without re-dispatching the whole task. |

### Two generic usage samples

**Sample 1 — implement a feature from a plan**

```
You: "Execute tasks 3, 4, and 5 from docs/plans/auth-rewrite.md"
↓
Client picks mma-execute-plan (plan file on disk, multiple tasks)
↓
mma runs the tasks as one sequential goal-set: the standard agent (e.g. MiniMax-M3)
implements each task in order and commits it (`[task N] …`), then the complex agent
reviews every task and fixes anything left — returning one structured report.
↓
You see one consolidated headline: "$0.04 actual / $1.20 saved vs claude-opus-4-8 (30× ROI)"
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
  fix; the reviewer verifies the failing test now passes 20× via its own shell tools.
↓
Total cost: ~$0.06. Main-context tokens consumed: just the hypothesis and the verdict.
```

## Configuration reference

### Lookup order

`--config <path>` → `$MMA_CONFIG` → `<cwd>/.multi-model-agent.json` → `~/.mma/config.json`.

### Agent types

| Type | Auth | When to pick |
|---|---|---|
| `claude` | Local Claude Code OAuth (`claude login`), or `apiKey`/`apiKeyEnv` with optional `baseUrl` | Claude subscription auth end-to-end, direct Anthropic API, or any Anthropic-compatible proxy (DeepSeek `/anthropic`, etc.) |
| `codex` | Codex CLI subscription (`codex login`), or `apiKey`/`apiKeyEnv` with optional `baseUrl` | OpenAI subscription auth, direct OpenAI API, or any OpenAI-compatible endpoint (MiniMax, Groq, Together, local vLLM, etc.) |

DeepSeek V4 Pro works as `"type": "claude"` with `baseUrl` pointed at its Anthropic-compatible endpoint. This preserves thinking content blocks across multi-turn tool use. Set `baseUrl` + `apiKeyEnv` on either type to reach any third-party endpoint.

```json
{
  "agents": {
    "complex": {
      "type": "claude",
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
| `defaults.mainModel` | *(unset)* | Lowest-priority fallback for the main-model resolver chain (headers + per-client auto-detection take precedence). |

### Auth token

Generated on first `mma serve`. Retrieve with `mma print-token`, or set `MMA_AUTH_TOKEN` to override the file.

### Telemetry

**Off by default.** Opt in via `mma telemetry enable` (or `MMA_TELEMETRY=1`), or add the `telemetry` block directly to `~/.mma/config.json`:

```json
{
  "agents": { "...": "..." },
  "telemetry": {
    "enabled": true
  }
}
```

When opted in, every upload batch carries one `task.completed` event per task with exact integer counts (tokens, tool calls, files, turns, durations in ms) and cost estimates in USD — no bucketed fields, no session/install/skill events. Batches are signed with a per-install Ed25519 key (TOFU; generated at `~/.mma/identity.json`). Full disclosure of every collected field in [PRIVACY.md](./PRIVACY.md).

**Telemetry upgrade note:** Previous opt-ins are cleared on major schema upgrades. Run `mma telemetry enable` to opt in to the current wire schema (v6).

### Verbose / diagnostics

Add the `diagnostics` block to `~/.mma/config.json`:

```json
{
  "agents": { "...": "..." },
  "diagnostics": {
    "log": true,
    "verbose": true
  }
}
```

Or per-run via `mma serve --verbose --log`. JSONL goes to `~/.mma/logs/mma-<date>.jsonl`; large request bodies (>16 KB UTF-8) spill to `~/.mma/logs/requests/<taskId>.json`.

> **Note:** verbose logs may include prompts, file paths, and other task content — disable for production servers handling sensitive data.

## Operator commands

```bash
mma serve [--verbose] [--log]                # start daemon
mma info  [--json]                           # cliVersion, bind/port, token fingerprint, daemon identity
mma status [--json]                          # health + stats from a running daemon
mma logs  [--follow] [--task=<id>]           # tail today's diagnostic log
mma print-token                              # print the current auth token
mma sync-skills [--target=<client>] [--all-targets] [--dry-run] [--json]   # idempotent install + update + reconcile
mma disable [--target=<client>] [--all-targets] [--dry-run] [--json]       # remove skills + pin off (survives upgrades)
mma enable  [--target=<client>] [--all-targets] [--dry-run] [--json]       # clear the pin + reinstall skills
mma telemetry status                         # show consent state + source (env / config / default)
mma telemetry enable                         # opt in (writes ~/.mma/config.json)
mma telemetry disable                       # opt out + delete local queue
mma telemetry reset-id                      # rotate the local Ed25519 identity (new install-id next run)
mma telemetry dump-queue                    # print the locally-queued events as JSON (pre-upload inspection)
```

## Architecture

`mma serve` runs a loopback HTTP server with a unified `POST /task` endpoint. All 11 task types (`delegate`, `execute_plan`, `audit`, `review`, `debug`, `investigate`, `research`, `journal_record`, `journal_recall`, `retry_tasks`, `main`) go through the same two-phase pipeline: implement on one tier, review on the other. The `main` type is a session-persistent orchestrator (no reviewer, no worktree) for multi-phase frontend workflows. Write types run as sequential goal-sets; read types fan out per file/criterion. Task dispatch is async — returns `202 { taskId, statusUrl }` immediately, poll `GET /task/:id` for the terminal envelope.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix
- [packages/server/README.md](./packages/server/README.md#rest-api) — full REST endpoint table + request/response shapes (for custom integrators)
- [DIRECTION.md](./DIRECTION.md) — product north star
- [packages/core/README.md](./packages/core/README.md) — embedding the runtime as a library (no HTTP server)
- [packages/server/README.md](./packages/server/README.md) — daemon, REST API, and skills detail

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 7337 already in use | `lsof -nP -i :7337` → kill the stale process |
| Daemon stale after upgrade | `pkill -f "mma serve"`; the skill preflight respawns it on next client session |
| Skill version mismatch | `mma sync-skills` and restart your client |
| `401 unauthorized` from a skill | `export MMA_AUTH_TOKEN=$(mma print-token)` |
| `pkill` reports success but `mma info` still shows the old PID | The pattern didn't match — try `kill <pid-from-mma-info>` directly |
| TLS `handshake_failure` to a known-good telemetry endpoint | Local DNS cache is stale. `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` (macOS); restart the daemon so it re-resolves |
| Local telemetry queue stops draining | Daemon's flusher is in exponential backoff after a transport failure (capped at 1 hr). Restart the daemon to force an immediate boot-flush |

## What's new in 5.4.4

- **Sandbox hardening.** Four new escape-detection vectors in the Claude confinement hook: cd-chain tracking, interpreter subshells, download tools, URL fragment filtering. Read-only tasks now get write enforcement too.
- **Dead config removed.** Parallel `SandboxPolicy` type and unused `sandboxPolicy` config fields eliminated — `TYPE_REGISTRY` is the single source of truth.

See [CHANGELOG](./CHANGELOG.md) for full details.

## License

MIT — see [`LICENSE`](./LICENSE).
