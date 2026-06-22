# @zhixuan92/multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP daemon that delegates tool-using work to sub-agents on different LLM providers. One process serves Claude Code, Codex CLI, Gemini CLI, and Cursor via installable skills.

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste.

| Project | MMA — MiniMax-M3 | MMA — DeepSeek V4 Pro | Flagship: Claude Opus 4.8 |
|---|---|---|---|
| Feature impl (30 files, ~50 tasks) | **$1.50** · **33× ROI** · ~35 min | **~$2.50** · **20× ROI** · ~15 min | $50 · 1× · *baseline* |
| Full web SPA (59 tasks) | **$5.65** · **12× ROI** · ~50 min | **~$9** · **7.5× ROI** · ~22 min | $68 · 1× · *baseline* |
| Backend microservice (91 tasks) | **$8.21** · **13× ROI** · ~1.5 hrs | **~$14** · **7.5× ROI** · ~40 min | $104 · 1× · *baseline* |

Plus structural quality: implementation and review run on **different** model families — different blind spots, catches what self-review can't.

## Initial setup

Four steps, in order.

### 1. Install CLI + skills

```bash
pnpm i -g @zhixuan92/multi-model-agent      # requires Node ≥ 22 (npm works too)
mma sync-skills                         # auto-detect all clients (idempotent install + update)
# or pin a specific target:
mma sync-skills --target=claude-code    # claude-code | gemini-cli | codex-cli | cursor
```

| Client | Install location | Loaded |
|---|---|---|
| Claude Code | `~/.claude/skills/` | next session |
| Gemini CLI | Gemini CLI skill directory | next session (requires version with external-skill support) |
| Codex CLI | `~/.codex/skills/` | next session |
| Cursor | Cursor extension manifest | restart Cursor |

### 2. Choose your main model — intentionally

Your **main model** is **the model you'd use without mma** — the cost baseline for every per-task headline (`$X actual / $Y saved vs <mainModel> (Z× ROI)`).

Both `X-MMA-Client` and `X-MMA-Main-Model` are required on tool routes (`400 client_required` / `400 main_model_required` if missing).

```bash
export MMA_CLIENT=claude-code              # or codex-cli, gemini-cli, cursor
export MMA_MAIN_MODEL=claude-opus-4-8      # whatever your calling agent runs on
```

### 3. Write the config

```bash
mkdir -p ~/.mma && cat > ~/.mma/config.json <<'EOF'
{
  "agents": {
    "standard": {
      "type": "codex",
      "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    },
    "complex": {
      "type": "codex",
      "model": "gpt-5.5",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
EOF
```

That's the whole minimum-viable file. All other knobs have sane built-in defaults.

### 4. Start the daemon + verify

```bash
mma serve                          # 127.0.0.1:7337 by default
curl -s http://localhost:7337/health   # → {"status":"ok"}
```

## Updating

```bash
pnpm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mma serve"            # stop the running daemon
mma sync-skills                 # reconcile installed skills with the new bundle
```

## Skills

Skills are the surface your AI client sees. `mma sync-skills` writes them to the client's skill directory. You describe the work, the client routes it to the matching skill, the skill calls the unified `POST /task` endpoint.

### Work-delegation skills

| Skill | Task type | Use when |
|---|---|---|
| `mma-delegate` | `delegate` | Ad-hoc implementation or research tasks without a plan file |
| `mma-execute-plan` | `execute_plan` | A plan markdown exists on disk with numbered task headings |
| `mma-investigate` | `investigate` | Answer a question about this codebase |
| `mma-explore` | *(orchestrator)* | Fans out investigate + research + journal-recall in parallel |
| `mma-research` | `research` | External multi-source research with citations |
| `mma-debug` | `debug` | Debug a failing test or unexpected behavior |
| `mma-review` | `review` | Source-code review, one worker per file |
| `mma-audit` | `audit` | Audit a spec/plan/design doc for executability blockers |
| `mma-journal-record` | `journal_record` | Record a durable project learning |
| `mma-journal-recall` | `journal_recall` | Recall relevant prior learnings |

### Plumbing skills

| Skill | Endpoint | Use when |
|---|---|---|
| `mma-context-blocks` | `POST/DELETE /context-blocks` | Reuse a large doc across multiple calls |
| `mma-retry` | `retry` task type | Re-run failed indices from a previous task |

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

All task types dispatch through the unified `POST /task` endpoint with a `type` discriminator.

| Endpoint | Purpose |
|---|---|
| `POST /task?cwd=<abs>` | Submit a task (delegate, audit, review, debug, execute_plan, investigate, research, journal_record, journal_recall, retry_tasks, orchestrate) |
| `GET /task/:taskId` | Poll task status and results |
| `POST /configure-provider` | Validate and optionally hot-swap a provider/model/auth for a tier |
| `POST /context-blocks?cwd=<abs>` | Register a reusable context block |
| `DELETE /context-blocks/:id?cwd=<abs>` | Delete a context block |
| `GET /health` | Liveness probe (unauthenticated) |
| `GET /status` | Server status (authenticated) |

All endpoints except `/health` require bearer auth: `Authorization: Bearer <token>`.

## Operator commands

```bash
mma serve [--log]                            # start daemon
mma info  [--json]                           # version, bind/port, token fingerprint
mma status [--json]                          # health + stats from a running daemon
mma logs  [--follow]                         # tail diagnostic log
mma print-token                              # print the current auth token
mma sync-skills [--target=<client>]          # install/update skills
mma disable [--target=<client>]              # remove skills
mma enable  [--target=<client>]              # reinstall skills
mma telemetry status|enable|disable          # manage telemetry consent
```

## Architecture

`mma serve` runs a loopback HTTP server. All task types go through a unified two-phase pipeline: the standard agent implements, then the complex agent reviews. Each task has a wall-clock timeout and bounded execution.

Full design rationale: [DIRECTION.md](https://github.com/zhixuan312/multi-model-agent/blob/master/DIRECTION.md). Layer map and request lifecycle: [docs/ARCHITECTURE.md](https://github.com/zhixuan312/multi-model-agent/blob/master/docs/ARCHITECTURE.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
