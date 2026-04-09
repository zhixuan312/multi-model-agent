# multi-model-agent

MCP server that delegates tasks to sub-agents running on different LLM providers. Send a list of tasks, each targeting a specific provider, and they execute concurrently with built-in tool use, timeout handling, and file-system sandboxing.

The `delegate_tasks` tool description is auto-populated with a capability matrix covering every configured provider (tools, quality tier, cost tier, strengths) plus a routing recipe, so the consuming LLM can make informed routing decisions. Tasks must declare `tier` and `requiredCapabilities` as a forcing function against lazy routing.

## Supported Providers

| Type | SDK | Notes |
|------|-----|-------|
| `openai-compatible` | `@openai/agents` + `openai` | Any OpenAI-compatible API (OpenAI, Groq, Together, local models) |
| `claude` | `@anthropic-ai/claude-agent-sdk` | Anthropic Claude models |
| `codex` | Built-in | OpenAI Codex |

## Quick Start

### Install

```bash
npm install multi-model-agent
```

`@openai/agents` and `openai` are optional peer dependencies — install them only if you use `openai-compatible` providers.

### Configure

Create `~/.multi-model/config.json`:

```json
{
  "providers": {
    "claude": {
      "type": "claude",
      "model": "claude-opus-4-6"
    },
    "codex": {
      "type": "codex",
      "model": "gpt-5-codex",
      "hostedTools": ["web_search"]
    },
    "minimax": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "costTier": "free"
    },
    "local": {
      "type": "openai-compatible",
      "model": "llama-3",
      "baseUrl": "http://localhost:8080/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "costTier": "free"
    }
  },
  "defaults": {
    "maxTurns": 200,
    "timeoutMs": 600000,
    "tools": "full"
  }
}
```

> Use `apiKeyEnv` instead of `apiKey` to avoid hardcoding secrets in the config file. Point `costTier` at `"free"` for any provider you consider effectively zero-cost (flat-rate plans, self-hosted models) — the routing recipe will then actively prefer it when capability matches.

Config is loaded from (in order):
1. `--config <path>` flag
2. `MULTI_MODEL_CONFIG` environment variable
3. `~/.multi-model/config.json`

### Run the MCP Server

```bash
npx multi-model-agent serve
# or
npx multi-model-agent serve --config ./my-config.json
```

The server communicates over stdio using the [Model Context Protocol](https://modelcontextprotocol.io/).

## MCP Tool: `delegate_tasks`

The server exposes a single tool, `delegate_tasks`, which accepts an array of tasks to run in parallel:

```json
{
  "tasks": [
    {
      "prompt": "Refactor the auth module to use JWT",
      "provider": "claude",
      "tier": "reasoning",
      "requiredCapabilities": ["file_read", "file_write"],
      "tools": "full",
      "maxTurns": 100,
      "timeoutMs": 300000,
      "cwd": "/path/to/project",
      "sandboxPolicy": "cwd-only"
    },
    {
      "prompt": "Write unit tests for the auth module",
      "provider": "minimax",
      "tier": "standard",
      "requiredCapabilities": ["file_read", "file_write", "grep"]
    }
  ]
}
```

### Task Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | required | Task prompt for the sub-agent |
| `provider` | `string` | required | Provider name from config |
| `tier` | `"trivial" \| "standard" \| "reasoning"` | required | Quality tier the task needs. Forces the consumer LLM to commit to a judgment before routing. |
| `requiredCapabilities` | `Capability[]` | required | Capabilities the task needs (empty array if none). Values: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`. The consumer LLM must exclude providers missing any required capability. |
| `tools` | `"none" \| "full"` | `"full"` | Tool access mode |
| `maxTurns` | `number` | `200` | Max agent loop turns |
| `timeoutMs` | `number` | `600000` | Timeout in milliseconds |
| `cwd` | `string` | — | Working directory for file/shell tools |
| `effort` | `string` | — | Reasoning effort level |
| `sandboxPolicy` | `"none" \| "cwd-only"` | `"cwd-only"` | File-system confinement policy |

### Routing Guidance

At MCP connect time, the server injects a rendered capability matrix into the `delegate_tasks` tool description. The consuming LLM sees this once per session and uses it to route subtasks. Example rendered output for a 3-provider config:

```
Available providers:

codex (gpt-5-codex)
  tools: file_read, file_write, grep, glob, shell, web_search
  tier: standard | cost: medium
  best for: code implementation + live data lookup

claude (claude-opus-4-6)
  tools: file_read, file_write, grep, glob, shell, web_search, web_fetch
  tier: reasoning | cost: high
  best for: complex, uncertain, open-ended tasks requiring judgment

minimax (MiniMax-M2)
  tools: file_read, file_write, grep, glob
  tier: standard | cost: free (from config)
  best for: well-defined local code tasks with explicit requirements
  avoid for: ambiguous or research-style tasks

How to route a task:
1. Capability filter (HARD): exclude providers missing any required capability.
2. Quality filter: exclude providers whose tier is below the task's tier.
3. Cost preference (STRONG): among the remainder, prefer the cheapest tier.
   If a 'free' provider qualifies, pick it.
```

**Model profiles** are matched by family prefix against the configured model id. Known families: `claude-opus`, `claude-sonnet`, `gpt-5`, `MiniMax-M2`. Unknown models fall back to a safe default profile (`standard` tier, `medium` cost).

**Cost tiers** drive the "prefer cheapest qualifying provider" rule in the routing recipe. The default cost for each family is hardcoded; override per provider via the `costTier` config field. Set to `"free"` for flat-rate or self-hosted deployments so the consumer LLM actively prefers them when capability matches.

### Sub-Agent Tools

When `tools` is `"full"`, sub-agents get access to:

- **readFile** — read a file
- **writeFile** — create or overwrite a file (with parent directory creation)
- **grep** — search file contents by regex pattern
- **glob** — find files by glob pattern
- **listFiles** — list directory entries
- **runShell** — execute shell commands (only available when `sandboxPolicy` is `"none"`)

The `cwd-only` sandbox policy confines all file operations to the working directory, blocking path traversal and symlink escapes.

### Provider Config

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"codex" \| "claude" \| "openai-compatible"` | Provider type |
| `model` | `string` | Model identifier. Matched by family prefix to a profile (e.g., `claude-opus-4-6` → `claude-opus` family). |
| `effort` | `string` | Default reasoning effort |
| `maxTurns` | `number` | Default max turns |
| `timeoutMs` | `number` | Default timeout |
| `baseUrl` | `string` | API base URL (for `openai-compatible`) |
| `apiKey` | `string` | API key literal. Prefer `apiKeyEnv` to avoid hardcoding secrets. |
| `apiKeyEnv` | `string` | Environment variable name for API key |
| `sandboxPolicy` | `"none" \| "cwd-only"` | Default sandbox policy |
| `hostedTools` | `string[]` | Hosted tools: `"web_search"`, `"image_generation"`, `"code_interpreter"` |
| `costTier` | `"free" \| "low" \| "medium" \| "high"` | Overrides the family default cost tier. Use `"free"` for flat-rate or self-hosted deployments so the routing recipe prefers them. |

## Development

```bash
npm run build        # TypeScript compile
npm test             # Run all tests
npm run test:watch   # Watch mode
```

Requires Node >= 22.

## License

ISC
