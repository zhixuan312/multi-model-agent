# multi-model-agent

Delegate the labor, keep the judgment. Your expensive model stays on architecture — mechanical work runs on a fleet of cheaper agents, in parallel, for 90% less.

An MCP server for Claude Code, Codex CLI, Cursor, Gemini CLI, and Claude Desktop. One tool call dispatches tasks across any mix of models — auto-routed, cost-bounded, cross-agent reviewed.

## Why

Your flagship model reasoning about architecture is money well spent. That same model grepping files, writing boilerplate, and running tests is waste. multi-model-agent fixes this:

- **Save 90%+ on implementation labor.** Mechanical work runs on standard agents at $0.01-0.03/task. Review and audit runs on complex agents at $0.30-0.65/task. Your flagship model does neither.
- **Keep your context window clean.** Every task runs in an isolated worker context. Zero implementation tokens pollute your architect session.
- **Ship faster with parallelism.** Independent tasks execute concurrently — 30-45% wall-clock savings on multi-file work.
- **Catch bugs with cross-agent review.** Implementation and review run on different models. Different training data, different blind spots, structural quality you can't get from self-review.

| Project | Tasks | With multi-model-agent | Single flagship model | Saved | Time |
|---|---|---|---|---|---|
| Feature implementation (30 files) | ~50 | $1.50 | ~$50 | **97%** | ~35 min |
| Full web SPA | 59 | $5.65 | ~$68 | **92%** | ~50 min |
| Backend microservice | 91 | $8.21 | ~$104 | **92%** | ~1.5 hrs |

## Quick Start

Requires Node >= 22 and an MCP client.

### 1. Create config

Three agent types are supported — use whichever matches your setup:

| Type | Auth | API key needed? |
|---|---|---|
| `claude` | Your existing Claude Code / Claude subscription | No — uses local OAuth |
| `codex` | Your existing Codex subscription (`codex login`) | No — reads `~/.codex/auth.json` |
| `openai-compatible` | Any OpenAI-compatible API (GPT, MiniMax, DeepSeek, Groq, local vLLM) | Yes — `apiKeyEnv` or `apiKey` |

**If you have Claude Code and/or Codex** — zero API keys needed:

```bash
mkdir -p ~/.multi-model && cat > ~/.multi-model/config.json << 'EOF'
{
  "agents": {
    "standard": { "type": "codex", "model": "codex-mini-latest" },
    "complex": { "type": "claude", "model": "claude-sonnet-4-20250514" }
  },
  "defaults": { "timeoutMs": 1800000, "maxCostUSD": 10, "tools": "full" }
}
EOF
```

**If you prefer OpenAI-compatible endpoints:**

```bash
mkdir -p ~/.multi-model && cat > ~/.multi-model/config.json << 'EOF'
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
  },
  "defaults": { "timeoutMs": 1800000, "maxCostUSD": 10, "tools": "full" }
}
EOF
```

Mix and match freely — e.g., `claude` for complex + `openai-compatible` for standard.

### 2. Register the MCP server

```bash
# Claude/Codex agents (no env vars needed):
claude mcp add multi-model-agent -s user \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve

# OpenAI-compatible agents (pass API keys):
claude mcp add multi-model-agent -s user \
  -e MINIMAX_API_KEY=... -e OPENAI_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

<details><summary>Codex CLI / Claude Desktop / Cursor</summary>

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.multi-model-agent]
command = "npx"
args = ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"]

# Only needed for openai-compatible agents:
# [mcp_servers.multi-model-agent.env]
# MINIMAX_API_KEY = "..."
# OPENAI_API_KEY = "..."
```

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "multi-model-agent": {
      "command": "npx",
      "args": ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"],
      "env": {}
    }
  }
}
```

Add API key env vars only if using `openai-compatible` agents.

</details>

### 3. Verify

```bash
claude mcp list   # should show multi-model-agent
```

Your AI assistant now has 9 tools. Ask it to delegate work — it knows when to use them.

## How It Works

You configure two labor slots:

| Slot | Purpose | Example models |
|---|---|---|
| `complex` | Advanced labor — code review, auditing, security analysis | GPT-5, Claude Opus, Claude Sonnet |
| `standard` | Heavy lifting — file writes, test runs, implementation | MiniMax, DeepSeek, Claude Haiku |

Your own model (whatever you're talking to) stays on architecture, design, and decisions. It never enters the labor slots.

Every task goes through a reviewed lifecycle:

```
Compile → Classify → Resolve → Implement → Spec review → Quality review → Report
```

The intake pipeline interprets your request, infers missing details, and either executes immediately or asks for confirmation when confused. Implementation and review run on *different* agents — cross-agent review catches what self-review can't.

## Tools

**Core**

| Tool | Purpose |
|---|---|
| `delegate_tasks` | Dispatch tasks in parallel with minimal input: `prompt` plus optional `agentType`, `filePaths`, `done`, and `contextBlockIds` |

**Specialized presets** — if you use [superpowers](https://github.com/anthropics/claude-code-plugins) for Claude Code, these map directly to your workflow:

| Tool | Workflow match | Preset |
|---|---|---|
| `audit_document` | Spec auditing after brainstorming/planning | Complex agent, no review pipeline. Parallel file audit. Accepts `contextBlockIds` for delta mode (round 2+). |
| `review_code` | Code review after implementation | Complex agent, full spec + quality review. Parallel file review. Accepts `contextBlockIds` for diff-scoped/delta mode. |
| `verify_work` | Verification before completion | Standard agent, spec review only. Verify against checklist. Accepts `contextBlockIds` for shared context. |
| `debug_task` | Systematic debugging | Complex agent, full spec + quality review. Hypothesis-driven investigation. Accepts `contextBlockIds` for shared context. |

Not using superpowers? These tools work standalone — they're just opinionated defaults over `delegate_tasks` for common patterns.

**Utilities**

| Tool | Purpose |
|---|---|
| `register_context_block` | Store reusable context (long briefs, reference docs) |
| `retry_tasks` | Re-run specific tasks from a previous batch |
| `get_batch_slice` | Fetch output or telemetry from a previous batch |
| `confirm_clarifications` | Resume a clarification set by confirming or editing the MCP's proposed interpretation |

<details><summary><strong>Configuration</strong></summary>

Config lookup order: `--config <path>` → `MULTI_MODEL_CONFIG` env → `~/.multi-model/config.json`

Agent types: `openai-compatible`, `claude`, `codex`. Any OpenAI-compatible endpoint works — MiniMax, DeepSeek, Groq, Together, local vLLM.

Auth:
- **OpenAI-compatible**: `apiKeyEnv` (recommended) or inline `apiKey`
- **Claude**: Local Claude auth flow, or `ANTHROPIC_API_KEY` env
- **Codex**: `codex login`, or `OPENAI_API_KEY` env

</details>

<details><summary><strong>Security & Sandbox</strong></summary>

- Default `sandboxPolicy: "cwd-only"` confines agents to the task's working directory
- Path traversal and symlinks resolved via `fs.realpath` — escapes are rejected
- `runShell` is disabled under `cwd-only`. To allow shell access, set the agent or default config `sandboxPolicy` to `none`
- `readFile` rejects >50 MiB; `writeFile` rejects >100 MiB
- Never commit API keys — use `apiKeyEnv` and env vars

</details>

<details><summary><strong>Updating</strong></summary>

`npx -y @zhixuan92/multi-model-agent-mcp serve` fetches the latest version on each spawn. To update: fully quit your MCP client, reopen.

Pin a version for reproducibility:
```bash
npx -y @zhixuan92/multi-model-agent-mcp@2.4.0 serve
```

</details>

<details><summary><strong>Delegation rule for Claude Code</strong></summary>

Drop-in rule that automates the full pipeline. With [superpowers](https://github.com/anthropics/claude-code-plugins): auto-audits specs (3 rounds), auto-audits plans (2 rounds), dispatches implementation via MCP, auto-reviews code after each task. Without superpowers: routes judgment vs labor correctly.

```bash
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

Full reference: [`docs/claude-code-delegation-rule.md`](./docs/claude-code-delegation-rule.md)

</details>

<details><summary><strong>Troubleshooting</strong></summary>

| Problem | Fix |
|---|---|
| `No agents configured` | Create `~/.multi-model/config.json` or pass `--config` |
| Task never routes | Check `agentType` and your configured providers/capabilities match the task |
| Shell tasks fail | Set `sandboxPolicy: "none"` on the agent or in defaults config |
| `openai-compatible` fails | Add `baseUrl` + `apiKey`/`apiKeyEnv` |
| Client doesn't see changes | Fully quit and reopen the MCP client |

</details>

<details><summary><strong>Local development</strong></summary>

```bash
npm install && npm run build && npm test
```

| Package | Purpose |
|---|---|
| `@zhixuan92/multi-model-agent-core` | Routing, config, runners, execution |
| `@zhixuan92/multi-model-agent-mcp` | MCP stdio server, tool schemas |

</details>

## License

MIT — see [`LICENSE`](./LICENSE).
