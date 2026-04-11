# @zhixuan92/multi-model-agent-mcp

MCP stdio server for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent). Exposes four tools — `delegate_tasks`, `register_context_block`, `retry_tasks`, and `get_task_output` — that run work in parallel across multiple LLM providers (Claude, Codex, OpenAI-compatible) and auto-route each task to the cheapest provider that can handle it.

## Features

- **Auto-routing**: routes each task by capability filter → quality tier → cheapest qualifying provider
- **Parallel execution**: independent tasks run concurrently via `Promise.all`
- **Escalation on failure**: auto-routed tasks walk the full provider chain on failure, stopping at the first success
- **Scratchpad salvage**: every termination path (incomplete, max_turns, timeout, error) populates output from the runner's scratchpad — no bare failures
- **Response pagination**: configurable `responseMode` (full/summary/auto) prevents Claude Code inline rendering limits on large combined outputs; use `get_task_output` to fetch individual results from summary-mode batches
- **Declare enumerable-deliverable coverage** (`expectedCoverage`) and get semantic incompleteness detection via re-prompting
- **Bounded post-hoc progress traces** (`includeProgressTrace`) for long-running task debugging
- **Visible cost and time savings**: `parentModel` + `savedCostUSD` per task; `timings` and `aggregateCost` batch-level aggregates for delegation ROI visibility

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
      "cwd": "/path/to/project",
      "parentModel": "claude-sonnet-4-5",
      "includeProgressTrace": true
    },
    {
      "prompt": "Write tests for the auth module.",
      "tier": "standard",
      "requiredCapabilities": ["file_read", "file_write", "grep"],
      "tools": "full",
      "cwd": "/path/to/project",
      "expectedCoverage": {
        "minSections": 3,
        "sectionPattern": "^Test \\d+:",
        "requiredMarkers": ["happy path", "edge case"]
      }
    }
  ]
}
```

Per-task fields: `prompt`, `tier`, `requiredCapabilities`, `provider?`, `tools?`, `maxTurns?`, `timeoutMs?`, `cwd?`, `effort?`, `sandboxPolicy?`, `contextBlockIds?`, `expectedCoverage?`, `includeProgressTrace?`, `parentModel?`.

`expectedCoverage` supports `minSections?`, `sectionPattern?`, and `requiredMarkers?`. `includeProgressTrace` opts a task into returning its bounded post-hoc progress trace. `parentModel` lets the server estimate `savedCostUSD` relative to the calling model.

Capabilities: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`.

## Security

### Sandbox enforcement

The default `sandboxPolicy: "cwd-only"` confines delegated sub-agents to the task's working directory. The check runs inside every file-tool call in the core `assertWithinCwd` helper — violations are surfaced to the model as normal tool errors, so the model can retry with a valid path rather than silently failing.

1. **File reads** are allowed only inside `cwd` and its descendants. Path traversal (`../`, absolute paths outside `cwd`) is rejected.
2. **File writes** are subject to the same restriction.
3. **Symlink resolution uses `fs.realpath`.** A symlink inside `cwd` that points outside `cwd` is treated as outside and rejected — the check runs on the resolved real path, not the literal path.
4. **Nonexistent target paths** resolve by walking back to the nearest existing ancestor and re-applying the check, so symlinks in ancestor directories are still caught.
5. **`runShell` is hard-disabled** under `cwd-only`. The tool returns an error telling the model to use `readFile` / `writeFile` / `grep` / `glob` / `listFiles` instead. Set `sandboxPolicy: "none"` per-provider or per-task to opt in to shell.
6. **The check is per-call**, not per-session. Every tool invocation revalidates.
7. **Errors are surfaced to the model**, not silently swallowed, so the model can observe the rejection and adjust.

### Other hardening

- `readFile` rejects targets larger than 50 MiB; `writeFile` rejects content larger than 100 MiB.
- The server warns at config-load time if it sees an inline `apiKey` instead of `apiKeyEnv`.
- The server warns once if `~/.codex/auth.json` is group- or world-readable.
- `CODEX_DEBUG=1` enables raw request/response logging to stderr (do not enable in environments that ship logs anywhere).

## Documentation

Full docs, capability matrix, configuration reference, troubleshooting, and contributor guide:

→ **<https://github.com/zhixuan312/multi-model-agent#readme>**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
