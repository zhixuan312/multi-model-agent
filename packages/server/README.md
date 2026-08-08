# @zhixuan92/multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local daemon that delegates tool-using work to sub-agents on different LLM providers. One process serves eight canonical clients — Claude Code, Claude Desktop, Codex, Antigravity, Cursor, VS Code, opencode, Windsurf — over MCP, via installable skills and per-client MCP registration.

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste.

**Per-task cost at production token loads** — mean 59K input · 20K output · 1.4M cached-read tokens/task (one week of a 2-dev team, 1,256 tasks):

| Tier — role | Recommended model | Cost/task | vs flagship |
|---|---|---|---|
| **Flagship** — your architect / brain | Claude Opus 4.8 | $1.94 | — *baseline* |
| **Complex** — spec · review · debug | GPT-5.6 mid · Claude Sonnet 5 | **$0.78–0.80** | ~60% less |
| **Standard** — mechanical impl | MiniMax-M3 · GLM-5.2 | **$0.13–0.54** | 72–94% less |
| **Standard** — cheapest capable | DeepSeek V4 Pro | **$0.05** | **97% less** |

Measured across a **2-developer team over one week** (1,000 delegated tasks): **2.8× ROI — 64% less** than running the same work on the flagship, before parallelism.

Plus structural quality: implementation and review run on **different** model families — different blind spots, catches what self-review can't.

## Initial setup

Two commands.

```bash
npm i -g @zhixuan92/multi-model-agent      # requires Node ≥ 22 (pnpm works too)
mma setup
```

`mma setup` is the whole first run: it asks which models back each tier (probing each as you enter
it) and which clients to provision, then writes `~/.mma/config.json`, declares the roster, and runs
`sync-skills`. Re-run it to change anything — it prefills what is configured, so pressing Enter
through it is a no-op. It never writes a credential into the config: an API key is recorded as
`apiKeyEnv`, the **name** of an environment variable.

Everything below is reference — what the wizard chooses for you, and the individual commands for
scripting a machine without prompts.

### Clients

Which clients get touched is **declared, not just detected** — a merely-detected, undeclared client
is reported `suggested` by `mma clients` and left untouched. `mma setup` declares them for you; to do
it without prompts use `mma sync-skills --target=<ClientId>` (repeatable), or declare them durably in
`~/.mma/config.json`:

```json
{ "agents": { "...": "..." }, "clients": { "claude-code": "on", "cursor": "on" } }
```

| Client | Skills | MCP registration |
|---|---|---|
| Claude Code | `~/.claude/skills/` | plugin `.mcp.json`, or `~/.mma/plugin/.mcp.json` via `mma mcp install` |
| Claude Desktop | — (MCP only) | `claude_desktop_config.json`, via the `mma mcp` stdio bridge |
| Codex | `~/.codex/skills/` | `~/.codex/config.toml` |
| Antigravity | `~/.gemini/antigravity-cli/skills/` | — MMA writes none; Google replaced the home-level config with a CLI-installed plugin bundle (use `mma plugin build --target=agent-plugin`) |
| Cursor | `~/.agents/skills/` | `~/.cursor/mcp.json` |
| VS Code | `~/.agents/skills/` | — MMA writes none; VS Code publishes no stable user-level path (add it via *MCP: Open User Configuration*) |
| opencode | `~/.agents/skills/` | `~/.config/opencode/opencode.json` |
| Windsurf | — (MCP only) | `~/.codeium/windsurf/mcp_config.json` |

### 2. Choose your main model — intentionally

Your **main model** is **the model you'd use without mma**. It is the `agents.main` tier in your
config, and it is the cost baseline for every per-task headline
(`$X actual / $Y saved vs <agents.main.model> (Z× ROI)`).

`agents.main` is **required** — a config with only `standard` and `complex` does not start. There is
no per-request override: `mma_run` has no `mainModel` parameter and the `X-MMA-Main-Model` header no
longer exists. A per-call claim was usually absent over MCP, which made mma fall back to the
implementer tier's own model and report a negative saving for runs that saved money.

Client identity (which tool called mma) is still attributed automatically from MCP protocol
metadata — nothing to set for that.

### 3. Write the config

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
      "model": "gpt-5.6",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "main": {
      "type": "claude",
      "model": "claude-opus-4-8"
    }
  }
}
EOF
```

All three tiers are required. That's the whole minimum-viable file. All other knobs have sane built-in defaults.

### 4. Start the daemon + verify

```bash
mma                                # 127.0.0.1:7337 by default (serve is the default command)
curl -s http://localhost:7337/health   # → {"status":"ok"}
```

## Updating

```bash
mma update
```

Then **restart the applications it names**. That is the whole procedure.

`mma update` installs the new package, restarts the daemon and waits until it answers, refreshes
your skill files, updates the Claude Code plugin if you use one, and finishes by listing the
applications you have to restart yourself. Each step is verified rather than assumed. Run
`mma doctor` at any time to see the same information without changing anything.

Only two things ever need action from you:

| What changed | What you do |
|---|---|
| Engine behaviour — routing, providers, a new task type | Nothing. Restarting the daemon updates the tool surface for **every** client at once, because the daemon generates it. |
| Skill files, or the Claude Code plugin | **Restart the client.** Skill files and plugin directories are read when the application starts. |

Credentials never appear in that list. No client stores a fixed token — all of them resolve it when
they connect — so rotating the token needs no client update:
`rm ~/.mma/auth-token && mma restart`.

If you manage the npm package yourself, install it your own way and run `mma update --no-install`.

## Skills

Skills are the surface your AI client sees. `mma sync-skills` writes them to the client's skill directory. You describe the work, the client routes it to the matching skill, the skill calls the MCP tool `mma_run` with the matching `type`.

### Design & planning skills

| Skill | Task type | Use when |
|---|---|---|
| `mma-brainstorm` | *(orchestrator)* | Requirement interview — name the destination → grill the 8 components → confirmed decisions → dispatch `mma-spec` |
| `mma-spec` | `spec` | Write a formal spec from structured design decisions |
| `mma-plan` | `plan` | Write a contract-first, human-executable plan from a spec file (Contract + plan-authored acceptance tests, no impl code) |

### Work-delegation skills

| Skill | Task type | Use when |
|---|---|---|
| `mma-delegate` | `delegate` | Ad-hoc implementation or research tasks without a plan file |
| `mma-execute-plan` | `execute_plan` | A plan markdown exists on disk with numbered task headings |
| `mma-investigate` | `investigate` | Answer a question about this codebase |
| `mma-explore` | *(orchestrator)* | Braindump → fans out investigate + research + journal-recall in parallel → writes `exploration.md` |
| `mma-research` | `research` | External multi-source research with citations |
| `mma-debug` | `debug` | Debug a failing test or unexpected behavior |
| `mma-review` | `review` | Source-code review, one worker per file |
| `mma-audit` | `audit` | Audit a spec/plan/design doc for executability blockers |
| `mma-journal-record` | `journal_record` | Record a durable project learning |
| `mma-journal-recall` | `journal_recall` | Recall relevant prior learnings |

### Plumbing skills

| Skill | MCP tools | Use when |
|---|---|---|
| `mma-context-blocks` | `mma_context_block_create` / `mma_context_block_delete` | Reuse a large doc across multiple calls |

### Commands (Claude Code only)

| Command | What it does |
|---|---|
| `/mma-flow` | Self-locating SDLC playbook — detects project stage, confirms design freeze, runs the autonomous Build chain to committed code. |
| `/mma-breakout` | Claude Code-only interactive expert-persona breakout — spawns a named breakout teammate, keeps deep dialogue isolated from the main thread, then records one confirmed journal batch. |

## Configuration reference

### Agent types

Two provider types (v4.4+):

| Type | Auth | When to pick |
|---|---|---|
| `claude` | Claude Code OAuth or `apiKey`/`apiKeyEnv` | Anthropic API or any Anthropic-compatible proxy (set `baseUrl`) |
| `codex` | Codex CLI subscription or `apiKey`/`apiKeyEnv` | OpenAI, DeepSeek, MiniMax, Groq, Together, Ollama — any OpenAI-compatible endpoint (set `baseUrl`) |

### Telemetry

**Off by default.** Opt in via `mma telemetry enable` (or `MMA_TELEMETRY=1`).

### Auth token

Generated on first `mma serve`. Retrieve with `mma print-token`, or set `MMA_AUTH_TOKEN` to override.

## REST API

The daemon's agent-facing surface is MCP (below) — no packaged skill, command, or plugin instructs
an agent to build an HTTP request. REST is fully supported behind the same runtime, for **Forge and
other programmatic callers**: all task types dispatch through the unified `POST /task` endpoint with
a `type` discriminator.

| Endpoint | Purpose |
|---|---|
| `POST /task?cwd=<abs>` | Submit a task (delegate, audit, review, debug, execute_plan, investigate, research, journal_record, journal_recall, orchestrate, spec, plan) |
| `GET /task/:taskId` | Poll task status and results (terminal results survive daemon restarts) |
| `DELETE /task/:taskId` | Request cooperative cancellation — 202 requested; terminal `cancelled` unless completion won the race; idempotent |
| `POST /mcp` | MCP endpoint (streamable HTTP, stateless) — tools `mma_run` / `mma_task_get` / `mma_task_wait` / `mma_task_list` / `mma_task_cancel` / `mma_context_block_create` / `mma_context_block_delete` over the same runtime, plus the `ui://mma/execution.html` App resource when its bundle is present |
| `POST /configure-provider` | Validate and optionally hot-swap a provider/model/auth for a tier |
| `POST /context-blocks?cwd=<abs>` | Register a reusable context block |
| `DELETE /context-blocks/:id?cwd=<abs>` | Delete a context block |
| `GET /health` | Liveness probe (unauthenticated) |
| `GET /status` | Server status (authenticated) |

All endpoints except `/health` require bearer auth: `Authorization: Bearer <token>`.

## Operator commands

```bash
mma setup                                    # interactive first run: models + clients + config, then sync-skills
mma [--log]                                  # start daemon (serve is the default command)
mma info  [--json]                           # version, bind/port, token fingerprint
mma status [--json]                          # health + stats from a running daemon
mma logs  [--follow]                         # tail diagnostic log
mma print-token                              # print the current auth token
mma clients [--json]                         # declared vs. detected vs. actual status, per client
mma mcp install <ClientId>                   # provision one client's MCP registration + skills now
mma sync-skills [--target=<ClientId>]        # provision every declared-'on' client
mma plugin build [--target=<t>] [--out <d>]  # emit a plugin package (claude-code | agent-plugin)
mma disable [--target=<ClientId>]            # declare 'off' + remove registration/skills
mma enable  [--target=<ClientId>]            # declare 'on' + (re)install
mma telemetry status|enable|disable          # manage telemetry consent
mma mcp                                      # stdio MCP bridge (Claude Desktop spawns this)
mma mcp uninstall                            # remove MMA from Claude Desktop's MCP config
```

## Claude Desktop and the execution monitor

Claude Desktop speaks stdio rather than HTTP. `mma mcp install claude-desktop` registers the `mma
mcp` bridge in Desktop's config; the bridge forwards stdio JSON-RPC to the same `POST /mcp`,
resolving the daemon host once at startup, rejecting any non-loopback answer and pinning the numeric
address so a DNS rebind cannot send the bearer token off-box.

Hosts implementing [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) render
`mma_run` as a live panel — phase, elapsed time, a headline of the worker's current activity, an
activity history the daemon derives from the run itself (so a panel opened late shows the same shape
as one open from the start), and a Cancel button — polled over the MCP channel, so progress costs
**no additional model turns**. The
resource is advertised only when its bundle is present, is self-contained (no external origins), and
is content-addressed so an upgrade is never served from a stale host cache. Non-App clients receive
byte-identical responses to before.

## Architecture

`mma serve` runs a loopback HTTP server. All task types go through a unified two-phase pipeline: the standard agent implements, then the complex agent reviews. Each task has a wall-clock timeout and bounded execution.

Full design rationale: [DIRECTION.md](https://github.com/zhixuan312/multi-model-agent/blob/master/DIRECTION.md). Layer map and request lifecycle: [docs/ARCHITECTURE.md](https://github.com/zhixuan312/multi-model-agent/blob/master/docs/ARCHITECTURE.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
