# @zhixuan92/multi-model-agent-mcp

MCP stdio server for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent). Exposes one tool — `delegate_tasks` — that runs work in parallel across multiple LLM providers (Claude, Codex, OpenAI-compatible) and auto-routes each task to the cheapest provider that can handle it.

## How it works

You don't run this server yourself. Your MCP client (Claude Code, Claude Desktop, Cursor, …) spawns it over stdio whenever a session starts, using the config snippet below. No install step, no long-running process to manage — `npx` fetches the latest version on demand.

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

## Setup

### Claude Code

One command — the client will spawn the server on demand. Use `-s user` so the server is available in **every** project on your machine, not just the directory where you ran the command:

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

If your providers need environment variables:

```bash
claude mcp add multi-model-agent -s user \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e MINIMAX_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

Without `-s user`, `claude mcp add` defaults to local scope and only registers the server in the current project.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-model-agent": {
      "command": "npx",
      "args": ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"],
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

## Recommended: delegation rule for Claude Code

Claude Code's native `Task` / `Agent` subagents inherit your parent session's expensive model and eat its context window. We ship a drop-in rule file that teaches Claude Code **when** to delegate work through `delegate_tasks` instead — mechanical edits go to free providers, reasoning-tier work escalates only when needed, and independent tasks run in parallel.

Install globally:

```bash
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

Restart Claude Code after installing. The full rule — judgment-vs-labor principle, decision procedure, provider routing table, dispatch shape, verification, escalation ladder — lives at [`docs/claude-code-delegation-rule.md`](https://github.com/zhixuan312/multi-model-agent/blob/HEAD/docs/claude-code-delegation-rule.md). Read that file before adapting it to your own provider names.

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
