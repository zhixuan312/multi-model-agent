# @zhixuan92/multi-model-agent-mcp

MCP stdio server for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent). Exposes one tool — `delegate_tasks` — that runs work in parallel across multiple LLM providers (Claude, Codex, OpenAI-compatible) and auto-routes each task to the cheapest provider that can handle it.

## Install

```bash
# Run without installing
npx @zhixuan92/multi-model-agent-mcp serve

# Or install globally
npm install -g @zhixuan92/multi-model-agent-mcp
multi-model-agent serve
```

If you plan to use `openai-compatible` providers, also install the optional peer dependencies:

```bash
npm install -g @zhixuan92/multi-model-agent-mcp @openai/agents openai
```

Requires Node `>= 22`.

## Configure

Create `~/.multi-model/config.json`:

```json
{
  "providers": {
    "claude": {
      "type": "claude",
      "model": "claude-sonnet-4-6",
      "costTier": "medium"
    },
    "codex": {
      "type": "codex",
      "model": "gpt-5-codex",
      "costTier": "medium"
    },
    "minimax": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "costTier": "free",
      "hostedTools": ["web_search"]
    }
  },
  "defaults": {
    "maxTurns": 200,
    "timeoutMs": 600000,
    "tools": "full"
  }
}
```

Config lookup order: `--config <path>` → `MULTI_MODEL_CONFIG` env var → `~/.multi-model/config.json`.

Provider auth:

- **`codex`** uses `codex login` if available, otherwise `OPENAI_API_KEY`
- **`claude`** uses `ANTHROPIC_API_KEY` if set, otherwise the local Claude auth flow
- **`openai-compatible`** uses `apiKeyEnv` (preferred) or inline `apiKey`

## Register with an MCP client

### Claude Code

```bash
claude mcp add multi-model-agent -- npx @zhixuan92/multi-model-agent-mcp serve
```

If your providers need environment variables:

```bash
claude mcp add multi-model-agent \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e MINIMAX_API_KEY=... \
  -- npx @zhixuan92/multi-model-agent-mcp serve
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-model-agent": {
      "command": "npx",
      "args": ["@zhixuan92/multi-model-agent-mcp", "serve"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MINIMAX_API_KEY": "..."
      }
    }
  }
}
```

Restart your MCP client after changing config.

## The `delegate_tasks` tool

Accepts an array of tasks and runs them concurrently. Auto-routes each task by capability filter → quality tier filter → cheapest remaining provider, or pin a task to a specific provider.

```json
{
  "tasks": [
    {
      "prompt": "Refactor auth.ts to use JWT.",
      "provider": "claude",
      "tier": "reasoning",
      "requiredCapabilities": ["file_read", "file_write"],
      "tools": "full",
      "cwd": "/path/to/project"
    },
    {
      "prompt": "Write tests for the auth module.",
      "tier": "standard",
      "requiredCapabilities": ["file_read", "file_write", "grep"],
      "tools": "full",
      "cwd": "/path/to/project"
    }
  ]
}
```

Per-task fields: `prompt`, `tier`, `requiredCapabilities`, `provider?`, `tools?`, `maxTurns?`, `timeoutMs?`, `cwd?`, `effort?`, `sandboxPolicy?`.

Capabilities: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`.

## Security

- File tools enforce a `cwd-only` sandbox by default — paths are resolved via `fs.realpath` and rejected if outside the task's `cwd`.
- `runShell` is hard-disabled under `cwd-only`. Set `sandboxPolicy: 'none'` per-provider or per-task to opt in.
- `readFile` rejects targets larger than 50 MiB; `writeFile` rejects content larger than 100 MiB.
- The server warns at config-load time if it sees an inline `apiKey` instead of `apiKeyEnv`.
- The server warns once if `~/.codex/auth.json` is group- or world-readable.
- `CODEX_DEBUG=1` enables raw request/response logging to stderr (do not enable in environments that ship logs anywhere).

## Documentation

Full docs, capability matrix, configuration reference, troubleshooting, and contributor guide:

→ **<https://github.com/zhixuan312/multi-model-agent#readme>**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
