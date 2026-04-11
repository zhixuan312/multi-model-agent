# @zhixuan92/multi-model-agent-mcp

**Delegate work from your expensive parent-session model to a fleet of cheaper sub-agents, in parallel, from a single MCP tool call.**

This is the MCP stdio server for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent). Your MCP client (Claude Code, Claude Desktop, Codex CLI, Cursor, …) spawns it on demand and gets four tools: `delegate_tasks`, `register_context_block`, `retry_tasks`, and `get_task_output`. Each `delegate_tasks` call runs the supplied tasks in parallel across the providers you configured, auto-routing each to the cheapest one that has the required capabilities and quality tier — or pinning to a specific provider when you want control.

## Why use it

- **Cut cost and context.** Mechanical work (file edits, search, doc lookups) runs on cheap providers in a clean worker context. Your parent session's window stays lean and its judgment unblocked.
- **Run tasks in parallel.** Independent tasks in one call execute concurrently; wall-clock time drops with task count.
- **Mix providers in one config.** Claude, Codex, and any OpenAI-compatible endpoint (MiniMax, DeepSeek, Groq, local vLLM, …) live side-by-side.
- **Auto-route and escalate.** Capability filter → tier filter → cheapest qualifying provider; on failure the chain is walked automatically, stopping at the first success.
- **No bare failures.** Every termination path (incomplete, max_turns, timeout, error) populates `output` from the runner's scratchpad.
- **Sandboxed by default.** `cwd-only` file tool confinement and shell-disabled by default. Opt out per-task only when needed.
- **Visible ROI.** Every response surfaces `aggregateCost`, `timings`, and per-task `savedCostUSD` for delegation savings.

## How it works

You don't run this server yourself. Your MCP client spawns it over stdio whenever a session starts, using the config snippets below. No install step, no long-running process to manage — `npx` fetches the latest version on demand each time.

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

### Codex CLI

Codex CLI reads MCP servers from `~/.codex/config.toml`. Add this block:

```toml
[mcp_servers.multi-model-agent]
command = "npx"
args = ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"]

[mcp_servers.multi-model-agent.env]
OPENAI_API_KEY = "sk-..."
ANTHROPIC_API_KEY = "sk-ant-..."
MINIMAX_API_KEY = "..."
```

Only set the env keys for the providers you actually configured. If you use `codex login`, the `codex` provider inside `multi-model-agent` reuses that auth automatically — but Claude, MiniMax, and other API-key providers still need to be passed through `[mcp_servers.multi-model-agent.env]` because the spawned MCP process does not inherit your shell environment. Restart `codex` after editing the file.

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

## Updating

`npx -y @zhixuan92/multi-model-agent-mcp serve` **always fetches the latest published version** on each spawn — you never need to run `npm update` or re-register the server to pick up a release.

To apply an update: **fully quit** your MCP client (⌘Q on macOS — just closing the window is not enough for Claude Code / Codex CLI because the MCP process lives with the session), then reopen. The next `delegate_tasks` call will spawn a fresh server from the latest npm version.

**Pinning a version** — if you need reproducibility (CI, shared team config, debugging a regression), add an explicit version tag to the spawn command:

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp@0.3.0 serve
```

or in `config.toml` / `claude_desktop_config.json`:

```toml
args = ["-y", "@zhixuan92/multi-model-agent-mcp@0.3.0", "serve"]
```

**Breaking changes** — this project is on 0.x semver. MINOR bumps (`0.2.x → 0.3.0`) may change the config schema or the `delegate_tasks` tool input. PATCH bumps (`0.3.0 → 0.3.1`) are strictly backwards-compatible bug fixes. Skim the [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/HEAD/CHANGELOG.md) before adopting a new MINOR version and update `~/.multi-model/config.json` (and any stored `delegate_tasks` call shapes in your rules/prompts) if the changelog calls out a schema change. Provider auth, the config file path, and the MCP tool names themselves are stable across all 0.x releases.

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
