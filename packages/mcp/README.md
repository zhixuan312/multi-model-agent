# @zhixuan92/multi-model-agent-mcp

**MCP server for multi-model-agent.** Your AI assistant gets 8 tools for delegating work to cheaper agents — parallel execution, cross-agent review, 90% cost savings.

Works with Claude Code, Codex CLI, Cursor, Gemini CLI, and Claude Desktop.

## Install

Requires Node >= 22 and a config file at `~/.multi-model/config.json`.

**1. Create config** — define your two agent slots. Three agent types are supported:

| Type | Auth | API key needed? |
|---|---|---|
| `claude` | Your existing Claude Code / Claude subscription | No — uses local OAuth |
| `codex` | Your existing Codex subscription (`codex login`) | No — reads `~/.codex/auth.json` |
| `openai-compatible` | Any OpenAI-compatible API (GPT, MiniMax, DeepSeek, Groq, local vLLM) | Yes — `apiKeyEnv` or `apiKey` |

**Example — Claude + Codex (no API keys):**

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

**Example — OpenAI-compatible endpoints (API keys required):**

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

**2. Register the MCP server:**

```bash
# Claude/Codex agents (no env vars needed):
claude mcp add multi-model-agent -s user \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve

# OpenAI-compatible agents (pass API keys):
claude mcp add multi-model-agent -s user \
  -e MINIMAX_API_KEY=... -e OPENAI_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

No install step, no long-running process. Your MCP client spawns it on demand via `npx`.

For Codex CLI, Claude Desktop, and Cursor setup, see the [full guide](https://github.com/zhixuan312/multi-model-agent#quick-start).

## What you get

| Tool | What it does |
|---|---|
| `delegate_tasks` | Dispatch tasks in parallel with minimal input: `prompt` plus optional `agentType`, `filePaths`, `done`, and `contextBlockIds`. Set `filePaths` for file-scoped work and `done` for acceptance criteria (required); do not invent extra fields. |
| `audit_document` | Audit docs/files for issues — parallel per file |
| `review_code` | Code review with spec + quality pipeline — parallel per file |
| `verify_work` | Verify work against a checklist — parallel per file |
| `debug_task` | Hypothesis-driven debugging with file context |
| `register_context_block` | Store reusable context for later tasks |
| `retry_tasks` | Re-run specific tasks from a previous batch |
| `get_batch_slice` | Fetch output or telemetry from a previous batch |

## Setup & Configuration

See the full setup guide with config examples, client-specific instructions, and auth details:

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent#quick-start)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
