# multi-model-agent

MCP server that delegates tasks to sub-agents running on different LLM providers. Send a list of tasks, each targeting a specific provider, and they execute concurrently with built-in tool use, timeout handling, and file-system sandboxing.

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
      "model": "claude-sonnet-4-20250514"
    },
    "gpt": {
      "type": "openai-compatible",
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "local": {
      "type": "openai-compatible",
      "model": "llama-3",
      "baseUrl": "http://localhost:8080/v1",
      "apiKeyEnv": "LOCAL_API_KEY"
    }
  },
  "defaults": {
    "maxTurns": 200,
    "timeoutMs": 600000,
    "tools": "full"
  }
}
```

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
      "tools": "full",
      "maxTurns": 100,
      "timeoutMs": 300000,
      "cwd": "/path/to/project",
      "sandboxPolicy": "cwd-only"
    },
    {
      "prompt": "Write unit tests for the auth module",
      "provider": "gpt"
    }
  ]
}
```

### Task Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | required | Task prompt for the sub-agent |
| `provider` | `string` | required | Provider name from config |
| `tools` | `"none" \| "full"` | `"full"` | Tool access mode |
| `maxTurns` | `number` | `200` | Max agent loop turns |
| `timeoutMs` | `number` | `600000` | Timeout in milliseconds |
| `cwd` | `string` | — | Working directory for file/shell tools |
| `effort` | `string` | — | Reasoning effort level |
| `sandboxPolicy` | `"none" \| "cwd-only"` | `"cwd-only"` | File-system confinement policy |

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
| `model` | `string` | Model identifier |
| `effort` | `string` | Default reasoning effort |
| `maxTurns` | `number` | Default max turns |
| `timeoutMs` | `number` | Default timeout |
| `baseUrl` | `string` | API base URL (for `openai-compatible`) |
| `apiKeyEnv` | `string` | Environment variable name for API key |
| `sandboxPolicy` | `"none" \| "cwd-only"` | Default sandbox policy |
| `hostedTools` | `string[]` | Hosted tools: `"web_search"`, `"image_generation"`, `"code_interpreter"` |

## Development

```bash
npm run build        # TypeScript compile
npm test             # Run all tests
npm run test:watch   # Watch mode
```

Requires Node >= 22.

## License

ISC
