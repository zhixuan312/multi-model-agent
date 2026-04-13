# @zhixuan92/multi-model-agent-mcp

**MCP server for multi-model-agent.** Your AI assistant gets 8 tools for delegating work to cheaper agents — parallel execution, cross-agent review, 90% cost savings.

Works with Claude Code, Codex CLI, Cursor, Gemini CLI, and Claude Desktop.

## Install

Requires Node >= 22, a config file, and API keys for your chosen providers.

**1. Create config** — define your two agent slots:

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
  "defaults": { "maxTurns": 200, "timeoutMs": 600000, "tools": "full" }
}
EOF
```

Any OpenAI-compatible endpoint works in either slot. For `claude` type agents, set up local Claude auth or `ANTHROPIC_API_KEY`. For `codex` type, run `codex login` first or set `OPENAI_API_KEY`.

**2. Register the MCP server** — pass your API keys as env vars:

```bash
claude mcp add multi-model-agent -s user \
  -e MINIMAX_API_KEY=... -e OPENAI_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

No install step, no long-running process. Your MCP client spawns it on demand via `npx`.

For Codex CLI, Claude Desktop, and Cursor setup, see the [full guide](https://github.com/zhixuan312/multi-model-agent#quick-start).

## What you get

| Tool | What it does |
|---|---|
| `delegate_tasks` | Dispatch tasks in parallel with full execution control |
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
