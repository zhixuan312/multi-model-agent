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

Delegate the labor, keep the judgment. Your flagship model stays on architecture and decisions — mechanical work runs on a fleet of cheaper agents, in parallel, for **up to 97% less per task**.

A local daemon for Claude Code, Claude Desktop, Codex, Cursor, VS Code, opencode, Windsurf, and Antigravity — reached over MCP. One tool call dispatches tasks across any mix of models — auto-routed, cost-bounded, cross-agent reviewed.

*(Replaced `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — see [CHANGELOG](./CHANGELOG.md).)*

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste. multi-model-agent fixes this.

- **Cut implementation cost up to 97%.** At production token loads (~59K input / 20K output / 1.4M cached-read tokens per task), a task that costs **~$1.94 on your flagship** (Claude Opus 4.8) runs for **~$0.05 on DeepSeek V4 Pro** or **~$0.13 on MiniMax-M3** — 94–97% less. Spec/quality review on a complex agent (**GPT-5.6 mid** or **Claude Sonnet 5**) is **~$0.80/task** (~60% less). Your flagship model does neither.
- **Keep your context window clean.** Every task runs in an isolated worker context. Zero implementation tokens pollute your architect session.
- **Ship faster with parallelism.** Independent tasks execute concurrently — 30–45% wall-clock savings on multi-file work.
- **Catch bugs with cross-agent review.** Implementation and review run on different model families. Different training data, different blind spots — structural quality you can't get from self-review.

**Per-task cost at production token loads** — mean 59K input · 20K output · 1.4M cached-read tokens/task (one week of a 2-dev team, 1,256 tasks):

| Tier — role | Recommended model | Cost/task | vs flagship |
|---|---|---|---|
| **Flagship** — your architect / brain | Claude Opus 4.8 | $1.94 | — *baseline* |
| **Complex** — spec · review · debug | GPT-5.6 mid · Claude Sonnet 5 | **$0.78–0.80** | ~60% less |
| **Standard** — mechanical impl | MiniMax-M3 · GLM-5.2 | **$0.13–0.54** | 72–94% less |
| **Standard** — cheapest capable | DeepSeek V4 Pro | **$0.05** | **97% less** |

Measured across a **2-developer team over one week** (1,000 delegated tasks): **2.8× ROI — 64% less** than running the same work on the flagship, before parallelism. Routing the standard tier to DeepSeek V4 Pro takes per-task mechanical savings to 97%.

## Initial setup

Two commands.

```bash
npm i -g @zhixuan92/multi-model-agent      # requires Node ≥ 22 (pnpm works too)
mma setup
```

`mma setup` is the whole first run. It asks two things — which models back each tier, and which
clients to provision — then writes `~/.mma/config.json`, declares your client roster, and runs
`sync-skills` for you. It probes each model as you enter it, so a green check means that tier
actually works before you leave the wizard.

Re-run it any time to change something: it prefills what is already configured, so pressing Enter
through it is a no-op, and it doubles as the way to read your current setup back.

It never writes a credential into the config — an API key is recorded as `apiKeyEnv`, the **name**
of an environment variable, because a config file is a backup/dotfile/git footgun.

Then [start the daemon](#4-start-the-daemon--verify). Everything below is reference: what the wizard
is choosing for you, and the individual commands to script the same thing without prompts.

### 1. Clients — what `mma setup` provisions

MMA provisions **eight canonical clients**, each with its own MCP registration and (where the
client supports Agent Skills) its own skill install. Which clients get touched is **declared, not
just detected** — a client that is merely detected but never declared is reported `suggested` and
left untouched, so a bare `mma sync-skills` with nothing declared yet provisions nothing. `mma setup`
declares them for you; to do it without prompts use `mma sync-skills --target=<ClientId>`
(repeatable), or declare `clients` in your config — see
[Declaring your clients](#declaring-your-clients) below.

| Client | Skills | MCP registration |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `${CLAUDE_PLUGIN_ROOT}/.mcp.json` (plugin) or `~/.mma/plugin/.mcp.json` (standalone `mma mcp install`) |
| Claude Desktop | — (MCP only) | `claude_desktop_config.json`, via the `mma mcp` stdio bridge |
| Codex | `~/.codex/skills/` | `~/.codex/config.toml` |
| Antigravity | `~/.gemini/antigravity-cli/skills/` | — (see below) |
| Cursor | `~/.agents/skills/` | `~/.cursor/mcp.json` |
| VS Code | `~/.agents/skills/` | — (see below) |
| opencode | `~/.agents/skills/` | `~/.config/opencode/opencode.json` |
| Windsurf | — (MCP only) | `~/.codeium/windsurf/mcp_config.json` |

Every registration entry resolves its bearer token **at connect time** — via a headers helper
script, a client's own `${env:VAR}`/`{env:VAR}` interpolation, or a `${file:...}` reference into
`~/.mma/auth-token` — never a static token written to disk.

**VS Code gets skills but not an MCP registration.** Microsoft documents the workspace-level path
(`.vscode/mcp.json`) but reaches the user-level file only through the *MCP: Open User Configuration*
command, and VS Code profiles are relocatable — so there is no stable home-level path for MMA to
write. Rather than guess one, MMA writes nothing: `mma mcp install vscode` refuses, and `mma clients`
reports `mcp=absent`. Add the server yourself through that command, pointing it at
`http://127.0.0.1:7337/mcp`.

**Antigravity gets skills but not an MCP registration.** Google folded Gemini CLI into Antigravity
CLI (Gemini CLI stopped serving Pro/Ultra requests on 2026-06-18) and replaced the home-level config
MMA used to write with a plugin bundle its own CLI installs — a different integration model, not a
moved path. MMA writes nothing rather than guess: `mma mcp install antigravity` refuses, and
`mma clients` reports `mcp=absent`. Install the Agent Plugins package instead
(`mma plugin build --target=agent-plugin`, then `agy plugin install <dir>`). Every other client's
path is verified against its vendor's own
documentation in
[`docs/verification/mcp-client-registration-profiles.md`](docs/verification/mcp-client-registration-profiles.md).

### Agent Plugins (one package, many clients)

The table above is MMA writing into each client's own config. The alternative is a package the
client installs itself:

```bash
mma plugin build --target=agent-plugin      # -> ~/.mma/plugin-agent-plugin
```

That emits an [Agent Plugins 1.0](https://agent-plugins.org/specification) package — root
`plugin.json`, the same 16 skills, and an `mcp.json` whose server is the `mma mcp` **stdio bridge**,
so no token is ever written into the package. Codex, Cursor and VS Code read this format directly;
Claude Code does not, and keeps its own package (`mma plugin build`, the default target). Both are
generated from the same skills — the payload never forks.

Agent Plugins deliberately defines no install protocol, so each client installs it its own way; the
generated `README.md` lists the exact command per client. The `mma` CLI must be on PATH at the same
version that generated the package.

#### Client support at a glance

| Client | Skills | SDLC commands | MCP server |
|---|---|---|---|
| **Claude Code** | ✅ | ✅ | ✅ |
| Claude Desktop | — | — | ✅ (via `mma mcp` stdio bridge) |
| Codex | ✅ | — | ✅ |
| Antigravity | ✅ | — | — (see below) |
| Cursor | ✅ | — | ✅ |
| VS Code | ✅ | — | — (see below) |
| opencode | ✅ | — | ✅ |
| Windsurf | — | — | ✅ |

Claude Code is the optimized path — it is the only client that can install skills, the SDLC
commands, and the MCP server as **one** unit (the plugin, below). Every declared client gets its
registration and applicable skills atomically through `mma sync-skills` / `mma mcp install
<ClientId>`. The engine itself treats all clients equally underneath: the same runtime, the same
task types, the same worker tiers — REST also exists behind the same runtime, for Forge and other
programmatic callers (see [packages/server/README.md#rest-api](./packages/server/README.md#rest-api)).

#### Declaring your clients

Detection alone never provisions anything. Declare a client's on/off state in
`~/.mma/config.json`:

```json
{
  "agents": { "...": "..." },
  "clients": {
    "claude-code": "on",
    "cursor": "on",
    "codex": "off"
  }
}
```

`mma clients [--json]` shows the full eight-client picture — declared state, detection, and actual
provisioning status:

```bash
mma clients
# claude-code   declared=on         detected=true   status=provisioned  skills=true  mcp=registered
# cursor        declared=on         detected=true   status=provisioned  skills=true  mcp=registered
# codex         declared=off        detected=true   status=off          skills=false mcp=absent
# vscode        declared=undeclared detected=true   status=suggested    skills=false mcp=absent
```

A `suggested` row is MMA telling you it *could* provision that client — run `mma mcp install
<ClientId>` for a one-off install without touching config, or add `clients.<ClientId>: "on"` and
re-run `mma sync-skills` to make it durable.

#### Claude Code: one-step plugin install (alternative)

Claude Code users can install the skills **and** the MCP server in a single step, from this repo's plugin marketplace:

```bash
/plugin marketplace add zhixuan312/multi-model-agent
/plugin install mma@multi-model-agent
```

That delivers 16 skills (`/mma:audit`, `/mma:delegate`, `/mma:review`, …), 2 SDLC commands (`/mma:flow`, `/mma:breakout`), and the MCP server pointed at your local daemon. The plugin drops the packaged `mma-` prefix because the plugin name already namespaces every component — `/mma:audit`, not `/mma:mma-audit`. The plugin contains **no auth token** — it reads yours at connection time from `$MMA_AUTH_TOKEN`, `$MMA_TOKEN_FILE`, or `~/.mma/auth-token`, and Claude Code re-reads it automatically if the token rotates.

> **The plugin supersedes standalone skills automatically.** Standalone (`mma sync-skills`) is the default, but the plugin is a strict superset — skills *plus* the SDLC commands *plus* the MCP server. So once the plugin is installed, `mma sync-skills` retires the standalone Claude Code copies and pins that client off, keeping exactly one install path. Without this you'd have two copies of every skill (`/mma-audit` **and** `/mma:audit`) with near-identical descriptions, and Claude would pick between them arbitrarily.
>
> This is deliberately **one-directional**: MMA cleans up its own `~/.claude/skills` entries but never uninstalls the plugin — `sync-skills` runs from npm postinstall, so the reverse would let a routine upgrade silently delete a plugin you chose. To go back to standalone: `claude plugin uninstall mma@multi-model-agent && mma enable --target=claude-code`. To keep both anyway: `mma sync-skills --target=claude-code --keep-standalone`.
>
> Other clients are unaffected — this overlap is Claude-Code-only.

### 2. Choosing your main model — intentionally (6.6.0+)

Your **main model** is **the model you'd use without mma**. It is the `agents.main` tier in your
config, and it does two jobs: it runs the `orchestrate` route, and it is the cost baseline for every
task. The per-task headline reports `$X actual / $Y saved vs <agents.main.model> (Z× ROI)`. Pick on
purpose:

- Heavy Claude Code user → `claude-opus-4-8`
- ChatGPT-led workflow → `gpt-5.6`
- Gemini-led workflow → `gemini-3.1-pro`

`agents.main` is **required**. A config with only `standard` and `complex` does not start, and the
error names the missing tier. Callers cannot supply the baseline per request: there is no `mainModel`
parameter on `mma_run` and no `X-MMA-Main-Model` header. You declare the value once and mma trusts
it.

The reason is that a per-call claim was usually absent over MCP, and mma then fell back to the
implementer tier's own model — one of the workers that had just run the task. That priced a run
against a worker instead of against your model, and reported a **negative** saving for runs that
actually saved money.

The trade-off: one declared value serves every client on a daemon, and it cannot follow a `/model`
switch inside a session. That costs some precision. It buys a baseline that is never a worker model
and that no caller can omit or mistype. If the price registry does not recognise your main model,
the comparison is reported as null rather than guessed.

Over MCP, client identity (which tool called mma) is still attributed automatically from the
connecting client — there is nothing to configure for that.

### 3. The config file

`mma setup` writes this for you. Paste it by hand only if you are scripting a machine — it creates `~/.mma/config.json` with the minimum-viable starter config (overwriting any existing file at that path):

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
      "model": "gpt-5.6"
    },
    "main": {
      "type": "claude",
      "model": "claude-opus-4-8"
    }
  }
}
EOF
```

All three tiers are required — see [Choosing your main model](#2-choosing-your-main-model--intentionally-660).
That's the whole minimum-viable file. All other knobs (`server.*`, `clients.*`, …) have sane built-in defaults — see [Configuration reference](#configuration-reference) for the override table and per-provider auth notes.

### 4. Start the daemon + verify

Two ways — pick one:

**Option A — let your AI client auto-spawn it.** Just open your client (Claude Code / Codex / etc.) and call any mma-* skill; the skill's preflight check spawns `mma serve` on `127.0.0.1:7337` and reuses it for every subsequent call. Nothing else to do.

**Option B — start it manually.** Useful when you want the daemon up before opening a client (e.g. to inspect the queue, run `curl /health`, or attach to logs):

```bash
mma                                # 127.0.0.1:7337 by default (serve is the default command)
curl -s http://localhost:7337/health   # → {"status":"ok"}
```

For a long-running background install (always-on, survives reboots), use [the launchd / systemd templates](./packages/server/scripts/README.md).

## Updating

```bash
mma update
```

Then **restart the applications it names**. That is the whole procedure.

`mma update` installs the new package, restarts the daemon and waits until it answers, refreshes
your skill files, updates the Claude Code plugin if you use one, and finishes by listing the
applications you have to restart yourself. It verifies each step instead of assuming it worked. Run
`mma doctor` at any time to see the same information without changing anything.

### What an update changes, and what you must do

An update touches four things. Only two of them ever need action from you.

| What changed | What you do |
|---|---|
| Engine behaviour — routing, providers, a new task type | Nothing. `mma update` restarts the daemon, and **every client picks up the new tool surface at once**, because the daemon generates it. |
| Skill files — how your client decides to call MMA | **Restart the client.** A client reads its skill files when it starts. |
| The Claude Code plugin | **Restart Claude Code.** A plugin directory is fixed when the application starts, so updating from inside a session does not affect that session. |
| MCP registration — the address or command your client uses (rare) | `mma mcp install <client>`, then restart the client. |

Credentials are never in that list. No client stores a fixed token: Claude Code runs a helper
script, Cursor and Codex read an environment variable, and Claude Desktop's bridge reads
`~/.mma/auth-token`. All four resolve it when they connect, so **rotating the token never requires a
client update** — `rm ~/.mma/auth-token && mma restart` and carry on.

### Per client

| Client | How it connects | Skill files | After an update |
|---|---|---|---|
| **Claude Code** | direct HTTP to the daemon | the plugin's copy, or `~/.claude/skills` | restart Claude Code |
| **Claude Desktop** | `mma mcp` bridge | none — this client has no skill mechanism | restart Claude Desktop |
| **Codex** | `mma mcp` bridge | `~/.codex/skills` | restart Codex |
| **Cursor** | direct HTTP to the daemon | `~/.agents/skills` | restart Cursor |

You never have two copies of the skills. When the Claude Code plugin is installed it provides them,
and `sync-skills` retires the standalone copies under `~/.claude/skills` and `~/.claude/commands`
rather than installing alongside. Pass `--keep-standalone` if you deliberately want both.

### Updating by hand

If you manage the npm package yourself, install it your own way and then run:

```bash
mma update --no-install
```

`mma update` also stops rather than guessing when it cannot tell which package manager owns the
install — it prints the exact command for you to run.

## Disabling / re-enabling

To turn MMA off without uninstalling the package — e.g. for a sensitive repo you don't want delegated to external models, or to compare behaviour with and without it:

```bash
mma disable --target=claude-code        # removes registration + skills; your AI stops routing to MMA
mma enable  --target=claude-code        # restores them
```

`disable` is **sticky**: it declares `clients.<ClientId>: "off"` in `~/.mma/config.json`, which `sync-skills` (including the `npm install` postinstall hook) honours, so an upgrade won't silently reinstall the skills. `enable` declares `"on"` and runs the normal `sync-skills` upsert to (re)install the client.

**Always name the client you're flipping:** `mma disable --target=<ClientId>` / `mma enable --target=<ClientId>` (repeatable, or `--all-targets`). A bare `mma disable` / `mma enable` with no `--target` only re-syncs clients **already** declared into that state — it does not discover which clients to flip, so it is not how you turn a specific client off or back on. Preview either with `--dry-run`. **Cursor skills are project-local**: `disable --target=cursor` removes them from the current working directory only, but the off declaration is global, so future `sync-skills` runs stay blocked for cursor everywhere until you `enable`. Re-run `enable --target=cursor` from each cursor project to reinstall its skills there.

## Skills

Skills are the surface your AI client sees. `mma sync-skills` writes the table below into the client's skill index and keeps it reconciled across upgrades; the client then picks the right one based on what you ask. You don't call them by hand — you describe the work, the client routes it.

### SDLC skills

| Skill | Use when |
|---|---|
| `mma-brainstorm` | Requirement interview — name the destination → grill the 8 spec components one decision at a time, resolving mechanical questions via workers and putting only real decisions to the user → dispatch `mma-spec`. Consumes an `exploration.md` from `mma-explore` when present. |
| `mma-spec` | Write a formal specification from structured design decisions. Output follows the 8-component spec standard (`## Context`, `## Problem`, `## Goals & Requirements`, `## Alternatives`, `## Technical Design`, `## Testing Plan`, `## Risks & Mitigations`, `## User Stories & Tasks`). |
| `mma-plan` | Write a contract-first, human-executable plan from a spec file. Output is phased (`## Phase N`, `### Task I-N:`) with `**Files:**` blocks, a Contract + technical acceptance criterion per task, and plan-authored acceptance tests — no implementation code. |

### Work-delegation skills

| Skill | Use when |
|---|---|
| `mma-delegate` | Ad-hoc implementation or research tasks **without** a plan file — run them on cheap workers as one goal-set (implement → review-fix). |
| `mma-execute-plan` | A plan / spec markdown exists on disk with numbered task headings; implement one or more tasks from it. |
| `mma-investigate` | Answer a question about *this* codebase ("how does X work", "where is Y called") without burning main-context tokens on grep + reads. |
| `mma-explore` | Orchestrator playbook — braindump → fans out `mma-investigate` + `mma-research` + `mma-journal-recall` in parallel → synthesises a written `exploration.md` (Background · Current State · Rough Direction, with 3–5 ranked directions). Divergent grounding before `mma-brainstorm`. Not for "where is X" questions (use `mma-investigate`). |
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
| `mma-orchestrate` | A multi-phase workflow needs a session-persistent LLM brain for orchestration — send a structured prompt, get a structured response, reuse the session across workflow phases. Uses the `main` tier (no reviewer, no commit). |

### Commands (Claude Code only)

| Command | Invoke with | What it does |
|---|---|---|
| `/mma-flow` | Type `/mma-flow` in Claude Code | Self-locating SDLC playbook — detects which stage the project is at (idea → spec → plan → execute → verify → review → green), confirms the design freeze, then runs the autonomous Build chain to committed code. |
| `/mma-breakout` | Type `/mma-breakout` in Claude Code | Claude Code-only interactive expert-persona breakout — spawns a named breakout teammate, keeps deep dialogue in direct `@name` conversation isolated from the main thread, then closes with one confirmed journal batch. |

### Two generic usage samples

**Sample 1 — implement a feature from a plan**

```
You: "Execute tasks 3, 4, and 5 from docs/plans/auth-rewrite.md"
↓
Client picks mma-execute-plan (plan file on disk, multiple tasks)
↓
mma runs the tasks as one sequential goal-set: the standard agent (e.g. DeepSeek V4 Pro)
implements each task in order and commits it (`[task N] …`), then the complex agent
reviews every task and fixes anything left — returning one structured report.
↓
You see one consolidated headline: "~$1.17 actual / ~$2.93 saved vs claude-opus-4-8 (~3.5× ROI)"
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
Total cost: ~$0.40 (debug trace + one delegated fix). Main-context tokens consumed: just the hypothesis and the verdict.
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

### Reasoning effort

Every tier runs at **`high`** unless you say otherwise — the same level on both runtimes. Override per tier with `effort`:

```json
{
  "agents": {
    "standard": { "type": "claude", "model": "claude-sonnet-5", "effort": "medium" },
    "complex":  { "type": "codex",  "model": "gpt-5.6-terra",   "effort": "xhigh" }
  }
}
```

| Level | claude | codex |
|---|---|---|
| `none` | `thinking: disabled` | `model_reasoning_effort="none"` |
| `low` / `medium` / `high` | ✅ | ✅ |
| `xhigh` / `max` | ✅ (newest models only) | ✅ (newest models only) |

Levels a model can't do are clamped by the runtime itself — claude downgrades silently, codex clamps to its model catalog. Models with no reasoning knob (GLM, DeepSeek, Kimi, Qwen, Gemini, Grok, …) never receive the parameter, whichever wire protocol they run behind.

### Tuning

Most knobs have a sane built-in. Override only when you have a reason.

| Field | Default | What it does |
|---|---|---|
| `agents.<tier>.effort` | `high` | Reasoning level for that tier — see [Reasoning effort](#reasoning-effort). |

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

When opted in, every upload batch carries one `task.completed` event per task with exact integer counts (tokens, tool calls, files, turns, durations in ms) and cost estimates in USD — no bucketed fields, no session/install/skill events. As of 6.3.0 it also carries which tools ran, per turn: tool names and counts only, never the arguments, paths, or commands they were given. Batches are signed with a per-install Ed25519 key (TOFU; generated at `~/.mma/identity.json`). Full disclosure of every collected field in [PRIVACY.md](./PRIVACY.md).

**Telemetry upgrade note:** Opting in is a stored decision that persists across upgrades — it is not re-requested when the wire schema changes, so an upgrade can widen what a standing opt-in covers (6.3.0 added tool names). The current wire schema is v6. Re-read [PRIVACY.md](./PRIVACY.md) after a release that changes the telemetry section, and run `mma telemetry disable` at any time to stop uploads and revoke the install's identity.

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
mma setup                                    # interactive first run: models + clients + config, then sync-skills
mma update [--no-install] [--package-manager=npm|pnpm|bun]  # update everything, then name what to restart
mma doctor [--json] [--offline]              # report every version surface + drift; exits non-zero on problems
mma [--verbose] [--log]                      # start daemon (serve is the default command)
mma stop    [--now]                          # stop the daemon and wait for it to exit (--now skips the drain)
mma restart [--now]                          # stop, start a replacement, wait until it answers /health
mma info  [--json]                           # cliVersion, bind/port, token fingerprint, daemon identity
mma status [--json]                          # health + stats from a running daemon
mma logs  [--follow] [--task=<id>]           # tail today's diagnostic log
mma print-token                              # print the current auth token
mma clients [--json]                         # declared vs. detected vs. actual status, per client
mma mcp install <ClientId>                   # provision one client's MCP registration + skills now
mma sync-skills [--target=<ClientId>] [--all-targets] [--dry-run] [--json]   # provision every declared-'on' client
mma plugin build [--target=claude-code|agent-plugin] [--out <dir>]            # emit a plugin package
mma disable [--target=<ClientId>] [--all-targets] [--dry-run] [--json]       # declare 'off' + remove (survives upgrades)
mma enable  [--target=<ClientId>] [--all-targets] [--dry-run] [--json]       # declare 'on' + (re)install
mma telemetry status                         # show consent state + source (env / config / default)
mma telemetry enable                         # opt in (writes ~/.mma/config.json)
mma telemetry disable                       # opt out + delete local queue
mma telemetry reset-id                      # rotate the local Ed25519 identity (new install-id next run)
mma telemetry dump-queue                    # print the locally-queued events as JSON (pre-upload inspection)
```

## Architecture

`mma` (or `mma serve`) runs a loopback daemon. Every declared client reaches it over **MCP** — skills
are thin prompts that route to MCP tools, never to a hand-built HTTP call. All 12 task types
(`delegate`, `execute_plan`, `audit`, `review`, `debug`, `investigate`, `research`, `journal_record`,
`journal_recall`, `orchestrate`, `spec`, `plan`) go through the same two-phase pipeline: an implementer
produces the answer on one tier, a refiner verifies and improves it on the other (both output the same
JSON schema). The `spec` type writes a formal specification (a human-alignment contract) from
structured decisions; the `plan` type writes a contract-first, human-executable phased plan — each task
a Contract plus plan-authored acceptance tests, no implementation code. The `orchestrate` type is a
session-persistent orchestrator (no refiner, no commit, cwd-only sandbox — can write files) for
multi-phase frontend workflows. Write types (`delegate`, `execute_plan`) edit the caller's checkout IN
PLACE on whatever branch it already has checked out and the engine commits there — it never creates a
branch or a worktree, because callers already do; read types use a read-only sandbox. Task dispatch is
async — a handle comes back immediately, poll for the terminal envelope; cancellation is cooperative
(terminal `cancelled` unless completion won the race). Task IDs and terminal results survive daemon
restarts (`~/.mma/state/executions.db`); executions caught mid-flight by a restart come back
`interrupted` with a retryable error — resubmit, nothing resumes.

The same runtime is also reachable over REST (`POST /task`, `GET /task/:id`, …) for Forge and other
programmatic callers — see [packages/server/README.md#rest-api](./packages/server/README.md#rest-api).
It is not part of the agent-facing surface: no packaged skill, command, or plugin instructs an agent to
construct an HTTP request.

### MCP endpoint

The daemon exposes the runtime over MCP at `POST /mcp` (streamable HTTP, stateless) — this is what
every declared client's skills and registration actually point at. Registration is per client, never
a manual header construction:

```bash
mma mcp install claude-code     # or any other ClientId — see the client table above
```

Seven tools, no per-type aliases: `mma_run` (the full `type`-discriminated task union — same schema
the REST endpoint validates, generated from one source), `mma_task_get`, `mma_task_wait`,
`mma_task_list`, `mma_task_cancel`, `mma_context_block_create`, `mma_context_block_delete`. `mma_run`
returns short task results inline and a handle for long ones; a task submitted over MCP is pollable
over REST and vice versa — one runtime, two transports.

Every reference to a task names it. The handle is `{ taskId, type, cwd }`, not a bare id, and each poll carries the same identity alongside progress, so `spec`, `review` and `investigate` are distinguishable without a lookup (an `audit` also carries its `subtype`). `mma_task_list` answers "what is running right now?" — the question you cannot ask when you no longer hold a taskId — optionally narrowed to one project.

**Claude Desktop** speaks stdio rather than HTTP, so it connects through a bridge instead:

```bash
mma mcp install claude-desktop     # writes Claude Desktop's MCP config (MCP only — no skills), then relaunch Desktop
```

`mma mcp` forwards stdio JSON-RPC frames to the same `POST /mcp`. It resolves the daemon host **once** at startup, rejects any non-loopback answer, and pins the numeric address, so a DNS rebind between requests cannot send your token off-box. Frames are forwarded concurrently — a long `mma_task_wait` must not block the monitor's own polls.

#### Execution monitor (MCP Apps)

Hosts that implement [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) render `mma_run` as a live panel: phase, elapsed time, a headline of what the worker is doing, and a Cancel button — polled over the existing MCP channel, so **progress costs no additional model turns**. On completion it reports duration, cost, the vs-main delta, the implementer/reviewer split, token usage (cache counted separately) and files changed; the answer itself stays in the conversation.

The daemon advertises this as the `io.modelcontextprotocol/ui` extension plus one resource, `ui://mma/execution.html` — self-contained, no external origins, and content-addressed so an upgrade is never served from a stale host cache. It is advertised **only when the bundle is actually present**, so a build without it degrades to plain tool responses rather than offering a UI it cannot serve. The App carries no credential: every server call is brokered by the host.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix
- [docs/PLUGIN.md](./docs/PLUGIN.md) — Claude Code plugin: how it's generated, the marketplace, publishing
- [packages/server/README.md](./packages/server/README.md#rest-api) — full REST endpoint table + request/response shapes (for custom integrators)
- [DIRECTION.md](./DIRECTION.md) — product north star
- [packages/core/README.md](./packages/core/README.md) — embedding the runtime as a library (no HTTP server)
- [packages/server/README.md](./packages/server/README.md) — daemon, REST API, and skills detail

## Troubleshooting

| Symptom | Fix |
|---|---|
| Not sure what state anything is in | `mma doctor` — reports every version surface and any drift, and changes nothing |
| Port 7337 already in use | `mma restart`. The daemon names the process that owns the port when it refuses to start |
| Daemon stale after upgrade | `mma restart`. Nothing respawns the daemon on its own — no skill starts it for you |
| Skill version mismatch | `mma sync-skills` and restart your client |
| A client fails to auth against the daemon | `export MMA_AUTH_TOKEN=$(mma print-token)` before launching the client, or `mma mcp install <ClientId>` again to rewrite its registration |
| Updated, but the client still behaves the old way | Restart the client. Skill files and plugin directories are read when the application starts |
| TLS `handshake_failure` to a known-good telemetry endpoint | Local DNS cache is stale. `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder` (macOS); restart the daemon so it re-resolves |
| Local telemetry queue stops draining | Daemon's flusher is in exponential backoff after a transport failure (capped at 1 hr). Restart the daemon to force an immediate boot-flush |

## What's new

- **`agents.main` is now required, and it is the cost baseline.** Add the tier to your config before
  upgrading — the daemon refuses to start without it and names what is missing. Every run is priced
  against the model you declared, never against a worker tier. Before this change mma guessed the
  baseline when a caller sent none, and the guess was one of the two models that had just run the
  task, so the per-task headline could report a negative saving for a run that saved money. The
  `mainModel` parameter and the `X-MMA-Main-Model` header are gone.
- **The code index has been removed.** `investigate` no longer starts with a pre-built list of
  candidate files, and `mma search` is gone. Measured against its own absence, the index made no
  difference on questions that name a symbol — plain `rg` already finds those — and it found the
  right file for 33% of questions phrased as sentences, against 25% for a worker that picks a
  keyword and greps. No measurement ever showed it improved answer quality. The journal index keeps
  every gain: record and recall stay at about 0.31 ms with unchanged retrieval quality. See the
  CHANGELOG for the full reasoning.

## License

MIT — see [`LICENSE`](./LICENSE).
