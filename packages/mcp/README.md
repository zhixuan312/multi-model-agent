# @zhixuan92/multi-model-agent-mcp

**MCP server for multi-model-agent.** Your AI assistant gets 10 tools for delegating work to cheaper agents — parallel execution, cross-agent review, 90% cost savings.

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
  "defaults": { "timeoutMs": 1800000, "maxCostUSD": 10, "tools": "full", "parentModel": "claude-opus-4-6" }
}
EOF
```

> **`parentModel`** (optional): When set, headlines show `$Y saved vs model (Zx ROI)`. When omitted, headlines show `$X actual`.

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
| `delegate_tasks` | Dispatch tasks in parallel with minimal input: `prompt` plus optional `agentType`, `filePaths`, `done`, and `contextBlockIds`. The MCP interprets your request and infers missing details — if confused, it returns a proposed interpretation for confirmation. |
| `audit_document` | Audit docs/files for issues — parallel per file. Accepts `contextBlockIds` for delta audits (round 2+). |
| `review_code` | Code review with spec + quality pipeline — parallel per file. Accepts `contextBlockIds` for diff-scoped/delta reviews. |
| `verify_work` | Verify work against a checklist — parallel per file. Accepts `contextBlockIds` for shared context. |
| `debug_task` | Hypothesis-driven debugging with file context. Accepts `contextBlockIds` for shared context. |
| `execute_plan` | Execute tasks from a plan document — worker reads plan files, finds matching task by descriptor, implements it. Multiple tasks run in parallel. |
| `register_context_block` | Store reusable context for later tasks |
| `retry_tasks` | Re-run specific tasks from a previous batch |
| `get_batch_slice` | Fetch output or telemetry from a previous batch |
| `confirm_clarifications` | Resume a clarification set by confirming or editing proposed interpretations |

## Diagnostic logging

Diagnostic logging is OFF by default.

It stays disabled when the `diagnostics` block is absent or when `diagnostics.log` is `false` in `~/.multi-model/config.json`.

To capture a crash/disconnect log to send us, add a `diagnostics` block to your config.

Minimal example:

```json
{
  "diagnostics": { "log": true }
}
```

Full config shape example:

```json
{
  "agents": {
    "standard": { "type": "codex", "model": "codex-mini-latest" },
    "complex": { "type": "claude", "model": "claude-sonnet-4-20250514" }
  },
  "defaults": {
    "timeoutMs": 1800000,
    "maxCostUSD": 10,
    "tools": "full"
  },
  "diagnostics": {
    "log": true,
    "logDir": "/some/path"
  }
}
```

`diagnostics.logDir` is optional; when omitted, logs default to `~/.multi-model/logs/`.

When enabled, the server appends JSONL records to `mcp-YYYY-MM-DD.jsonl` in append mode.

Only crash/disconnect diagnostic events are logged: `startup`, `request_start`, `request_complete`, `shutdown`, and `error`. This is a crash-diagnosis log, not a progress feed.

## Setup & Configuration

See the full setup guide with config examples, client-specific instructions, and auth details:

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent#quick-start)**

## Running as an HTTP daemon

The default transport is stdio — Claude Code spawns one `mmagent` process per session. When the Claude Code session ends (compaction, `/clear`, exit), the process dies; the next tool call has to start a fresh one.

To survive Claude Code lifecycle events, run `mmagent` as a long-running HTTP daemon. Multiple Claude Code sessions can connect to the same daemon (each pointing at its own project directory), and a client reconnect reuses the project's in-memory stores.

### Start the daemon

Foreground (quickest way to try):

```bash
mmagent serve --http
# → http://127.0.0.1:7312
```

Background (macOS launchd / Linux systemd): see `scripts/README.md`.

### Point Claude Code at the daemon

In each project's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "multi-model-agent": {
      "url": "http://127.0.0.1:7312/?cwd=/absolute/path/to/project"
    }
  }
}
```

Two projects = two `.mcp.json` files, each with a different `?cwd=`.

### Auth (optional)

For shared development machines:

```jsonc
// ~/.multi-model/config.json
{
  "transport": {
    "mode": "http",
    "http": { "auth": { "enabled": true } }
  }
}
```

On startup, `mmagent` generates a random token at `~/.multi-model/runtime/token` (mode 600). Paste it into `.mcp.json`:

```jsonc
{
  "url": "http://127.0.0.1:7312/?cwd=...",
  "headers": { "Authorization": "Bearer <token-from-that-file>" }
}
```

### Check daemon status

```bash
mmagent status
# mmagent 2.8.0  ·  pid 6821  ·  uptime 3h 24m  ·  http://127.0.0.1:7312
# Projects (2):
#   /Users/me/project-X    1 sess   7 batches   last seen 8s ago
#   /Users/me/project-Y    1 sess   2 batches   last seen 4m ago
```

### Upgrades

`npm i -g @zhixuan92/multi-model-agent-mcp@latest` writes the new binary but does not restart the running daemon. Restart manually:

- **launchd**: `launchctl kickstart -k gui/$(id -u)/com.zhixuan92.mmagent`
- **systemd**: `systemctl --user restart mmagent`
- **foreground**: `Ctrl-C` and run `mmagent serve --http` again.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
