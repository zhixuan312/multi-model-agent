# multi-model-agent

`multi-model-agent` is an MCP server for delegating work to multiple LLM providers from one tool call.

It gives your MCP client a single tool, `delegate_tasks`, and runs the requested tasks in parallel across the providers you configure. The server can auto-route tasks to the cheapest eligible provider based on required capabilities and quality tier, or you can pin a task to a specific provider.

## What Users Get

- One MCP tool: `delegate_tasks`
- Parallel task execution
- Multiple provider types in one config:
  - `codex`
  - `claude`
  - `openai-compatible`
- Auto-routing by:
  - required capabilities
  - task tier: `trivial`, `standard`, `reasoning`
  - effective cost tier: `free`, `low`, `medium`, `high`
- Optional filesystem sandboxing per provider or per task

## Packages

This repo contains two workspace packages:

| Package | Purpose |
| --- | --- |
| `@zhixuan92/multi-model-agent-core` | Routing, config loading, provider runners, task execution |
| `@zhixuan92/multi-model-agent-mcp` | MCP stdio server exposing `delegate_tasks` |

## Quick Start

### 1. Requirements

- Node.js `>=22`
- An MCP client such as Claude Code or Claude Desktop
- Credentials for at least one provider

Provider auth currently works like this:

- `codex`: uses `codex login` if available, otherwise `OPENAI_API_KEY`
- `claude`: uses `ANTHROPIC_API_KEY` if set, otherwise Claude's existing auth flow on the machine
- `openai-compatible`: uses `apiKey` or `apiKeyEnv` from your config

### 2. Install the MCP server

Use `npx`:

```bash
npx @zhixuan92/multi-model-agent-mcp serve
```

Or install globally:

```bash
npm install -g @zhixuan92/multi-model-agent-mcp
multi-model-agent serve
```

If you plan to use `openai-compatible` providers, install the optional peer dependencies too:

```bash
npm install -g @zhixuan92/multi-model-agent-mcp @openai/agents openai
```

### 3. Create your config

Create `~/.multi-model/config.json`:

```json
{
  "providers": {
    "codex": {
      "type": "codex",
      "model": "gpt-5-codex",
      "costTier": "medium"
    },
    "claude": {
      "type": "claude",
      "model": "claude-sonnet-4-6",
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

Config lookup order:

1. `--config <path>`
2. `MULTI_MODEL_CONFIG`
3. `~/.multi-model/config.json`

Recommended practice:

- Use `apiKeyEnv` instead of `apiKey`
- Set `costTier` for flat-rate or effectively free providers
- Only set `sandboxPolicy` to `none` if you want delegated tasks to run shell commands

### 4. Register the MCP server

For Claude Code:

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

For Claude Desktop, add this to `claude_desktop_config.json`:

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

### 5. Verify it works

In Claude Code:

```bash
claude mcp list
```

Then ask your client to call `delegate_tasks` with a trivial task such as:

```json
{
  "tasks": [
    {
      "prompt": "Say hello and report which provider handled this task.",
      "tier": "trivial",
      "requiredCapabilities": []
    }
  ]
}
```

## How Routing Works

When you omit `provider`, the server auto-selects one by:

1. Rejecting providers that do not have the required capabilities
2. Rejecting providers whose model tier is below the task tier
3. Picking the cheapest remaining provider
4. Breaking ties by provider name

The MCP tool description includes a live routing matrix based on your config so the orchestrating model can see:

- provider names
- model ids
- supported tools
- quality tier
- effective cost tier
- whether `effort` is supported

## `delegate_tasks` Input

`delegate_tasks` accepts an array of tasks and runs them concurrently.

Example:

```json
{
  "tasks": [
    {
      "prompt": "Refactor the auth module to use JWT.",
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

Task fields:

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Task to send to the sub-agent |
| `provider` | no | Provider name from config; omit for auto-routing |
| `tier` | yes | `trivial`, `standard`, or `reasoning` |
| `requiredCapabilities` | yes | Array of capabilities needed by the task |
| `tools` | no | `none` or `full`; default comes from config |
| `maxTurns` | no | Per-task override |
| `timeoutMs` | no | Per-task override |
| `cwd` | no | Working directory for file and shell tools |
| `effort` | no | `none`, `low`, `medium`, `high` |
| `sandboxPolicy` | no | `none` or `cwd-only` |

Supported capability names:

- `file_read`
- `file_write`
- `grep`
- `glob`
- `shell`
- `web_search`
- `web_fetch`

## Capability Notes

- File tools are available only when `tools` is not `none`.
- `shell` is available only when the effective `sandboxPolicy` is `none`.
- `codex` gets `web_search` by default unless you explicitly override `hostedTools`.
- `claude` exposes `web_search` and `web_fetch`.
- `openai-compatible` providers only get `web_search` if you add it to `hostedTools`.

## Configuration Reference

Provider fields:

| Field | Provider types | Notes |
| --- | --- | --- |
| `type` | all | `codex`, `claude`, `openai-compatible` |
| `model` | all | Model id passed to the runner |
| `baseUrl` | `openai-compatible` | Required |
| `apiKey` | `openai-compatible` | Optional inline secret |
| `apiKeyEnv` | `openai-compatible` | Recommended instead of `apiKey` |
| `effort` | all | Default reasoning effort |
| `maxTurns` | all | Provider-level default |
| `timeoutMs` | all | Provider-level default |
| `sandboxPolicy` | all | `none` or `cwd-only` |
| `hostedTools` | all | `web_search`, `image_generation`, `code_interpreter` |
| `costTier` | all | Overrides the default routing cost |

## Local Development

Repo layout:

- `packages/core`: routing, config loading, provider runners, task execution
- `packages/mcp`: MCP stdio server and tool schema
- `tests`: Vitest coverage
- `scripts`: local helper scripts

```bash
npm install
npm run build
npm test
```
- [Development Guide](docs/development.md)

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| `No providers configured` | Config file missing or empty | Create `~/.multi-model/config.json` or pass `--config` |
| Provider is never selected | Missing capability or insufficient tier | Check `requiredCapabilities`, `tier`, and your provider config |
| `shell` tasks fail | Sandbox is still `cwd-only` | Set provider or task `sandboxPolicy` to `none` |
| `openai-compatible` provider fails to start | `baseUrl` missing or peer deps missing | Add `baseUrl` and install `@openai/agents` plus `openai` |
| Codex auth fails | No local Codex login and no `OPENAI_API_KEY` | Run `codex login` or set `OPENAI_API_KEY` |
| MCP client does not see changes | Client not restarted | Fully quit and reopen the client |

## License

ISC
