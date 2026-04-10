# multi-model-agent

MCP server that delegates tasks to sub-agents running on different LLM providers. Send a list of tasks, each targeting a specific provider, they execute concurrently with built-in tool use, timeout handling, and file-system sandboxing.

## Packages

This repo is a npm workspace with two packages:

| Package | Description |
|--------|-------------|
| `@scope/multi-model-agent-core` | Execution engine: routing, config, provider abstraction |
| `@scope/multi-model-agent-mcp` | MCP transport adapter (stdio server) |

The `delegate_tasks` tool description is auto-populated with a capability matrix covering every configured provider (tools, quality tier, cost tier, strengths) plus a routing recipe, so the consuming LLM can make informed routing decisions. Tasks must declare `tier` and `requiredCapabilities` as a forcing function against lazy routing.

## Supported Providers

| Type | SDK | Notes |
|------|-----|-------|
| `openai-compatible` | `@openai/agents` + `openai` | Any OpenAI-compatible API (OpenAI, Groq, Together, local models) |
| `claude` | `@anthropic-ai/claude-agent-sdk` | Anthropic Claude models |
| `codex` | Built-in | OpenAI Codex |

## Setup

Five steps: install, create the app config, register with your MCP client, restart, verify.

### Step 1 — Install

```bash
npm install -g @scope/multi-model-agent-mcp
```

Or skip the global install — `npx @scope/multi-model-agent-mcp serve` works on demand. No functional difference.

`@openai/agents` and `openai` are optional peer dependencies — install them only if you use `openai-compatible` providers.

### Step 2 — Create the app config

Create `~/.multi-model/config.json`. This tells multi-model-agent which providers exist, which models to use, and how to route tasks.

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

> **Two important conventions**
> - Use `apiKeyEnv` (not `apiKey`) to avoid hardcoding secrets in the config file. The key goes in the MCP client's env block in Step 3.
> - Point `costTier` at `"free"` for any provider you consider effectively zero-cost (flat-rate plans, self-hosted models). The routing recipe will then actively prefer it when capability matches.

Config is loaded from (in order):
1. `--config <path>` flag
2. `MULTI_MODEL_CONFIG` environment variable
3. `~/.multi-model/config.json`

### Step 3 — Register the server with your MCP client

Pick the client you use:

#### Option A — Claude Code (recommended, one command)

```bash
claude mcp add multi-model-agent -- npx @scope/multi-model-agent-mcp serve
```

With provider API keys (one `-e` flag per key, matching the `apiKeyEnv` values in your config):

```bash
claude mcp add multi-model-agent \
  -e MINIMAX_API_KEY=sk-cp-... \
  -e OPENAI_API_KEY=sk-... \
  -- npx @scope/multi-model-agent-mcp serve
```

Useful flags:
- `--scope user` — register for all projects (default is current project only)
- `--scope project` — writes to `.mcp.json` in the project root, shareable with teammates

#### Option B — Claude Desktop (macOS)

Open the config file:

```bash
open "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

Add or extend the `mcpServers` block:

```json
{
  "mcpServers": {
    "multi-model-agent": {
      "command": "npx",
      "args": ["@scope/multi-model-agent-mcp", "serve"],
      "env": {
        "MINIMAX_API_KEY": "sk-cp-...",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Env values must be strings. No nesting, no numbers, no booleans.

#### Option C — Any other MCP client

Have the client spawn `npx @scope/multi-model-agent-mcp serve` over stdio and pass the required env vars via whatever mechanism it supports. The server follows the standard [Model Context Protocol](https://modelcontextprotocol.io/) on stdio.

### Step 4 — Restart the client

MCP config is only read at startup — there's no hot reload.

- **Claude Code**: `/exit` all sessions and relaunch.
- **Claude Desktop**: `Cmd-Q` and relaunch from Applications or Dock.

### Step 5 — Verify

**Claude Code:**

```bash
claude mcp list
```

You should see `multi-model-agent` with status `connected`. If it shows `failed`:

```bash
claude mcp get multi-model-agent
```

prints the error.

**Claude Desktop:** look for the MCP icon (plug/hammer) in the chat input area. It should show `multi-model-agent` in the dropdown.

**Sanity check** — in any new Claude session:

> Call `delegate_tasks` with a trivial "say hello" task on each configured provider and report the results.

If the tool appears and all providers respond, you're done.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `command not found` | Package not installed globally and `npx` couldn't resolve | `npm install -g @scope/multi-model-agent-mcp` or confirm `npx @scope/multi-model-agent-mcp serve` works from terminal |
| Server `failed` in `claude mcp list` | Missing env var for a provider | Re-register with `-e KEY=VAL` or add an `env` block to the JSON config |
| `No providers configured` error | Missing or unreadable `~/.multi-model/config.json` | Verify the file exists, is valid JSON, and the provider entries match the schema |
| Server starts but task delegation fails silently | Wrong model id or bad API key | Check provider dashboard for error logs; verify `apiKeyEnv` matches the env var name you set in Step 3 |
| Config changes not taking effect | Client wasn't fully restarted | Fully quit (not just close window) and relaunch |

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
| `provider` | `string` | auto | Provider name from config. If omitted, core auto-selects the cheapest eligible provider. |
| `tier` | `"trivial" \| "standard" \| "reasoning"` | required | Quality tier the task needs. Forces the consumer LLM to commit to a judgment before routing. |
| `requiredCapabilities` | `Capability[]` | required | Capabilities the task needs (empty array if none). Values: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`. |
| `tools` | `"none" \| "full"` | `"full"` | Tool access mode |
| `maxTurns` | `number` | `200` | Max agent loop turns |
| `timeoutMs` | `number` | `600000` | Timeout in milliseconds |
| `cwd` | `string` | — | Working directory for file/shell tools |
| `effort` | `"none" \| "low" \| "medium" \| "high"` | — | Reasoning effort. `"none"` disables thinking; `"low"`/`"medium"`/`"high"` scale reasoning depth. Only providers marked `effort: supported` in the routing matrix honor this. |
| `sandboxPolicy` | `"none" \| "cwd-only"` | `"cwd-only"` | File-system confinement policy |

### Routing Guidance

At MCP connect time, the server injects a rendered capability matrix into the `delegate_tasks` tool description. The consuming LLM sees this once per session and uses it to route subtasks. Example rendered output for a 3-provider config:

```
Available providers:

codex (gpt-5-codex)
  tools: file_read, file_write, grep, glob, shell, web_search
  tier: reasoning | cost: medium | effort: supported
  best for: coding, agentic workflows, and tool-using tasks
  note: live data lookup requires web/tool support, not model alone

claude (claude-opus-4-6)
  tools: file_read, file_write, grep, glob, shell, web_search, web_fetch
  tier: reasoning | cost: high | effort: supported
  best for: frontier coding, complex judgment, long-horizon agent tasks, high-stakes professional work

minimax (MiniMax-M2)
  tools: file_read, file_write, grep, glob
  tier: standard | cost: free (from config) | effort: supported
  best for: cost-efficient coding and agent workflows with clear requirements
  avoid for: highest-stakes ambiguous work when you need top-tier judgment

How to route a task:
1. Capability filter (HARD): exclude providers missing any required capability.
2. Quality filter: exclude providers whose tier is below the task's tier.
3. Cost preference (STRONG): among the remainder, prefer the cheapest tier.
   If a 'free' provider qualifies, pick it.
```

**Effort support** is per-model-family:

| Family | Supports effort? | How the runner wires it |
|---|---|---|
| `claude-opus`, `claude-sonnet` | ✅ | `queryOptions.thinking = { type: 'adaptive' }` + `queryOptions.effort` passed to the Claude Agent SDK |
| `gpt-5` (including `gpt-5-codex`) | ✅ | `reasoning: { effort }` passed to the Codex / OpenAI Responses API |
| `MiniMax-M2` | ✅ | `reasoning: { effort }` via the OpenAI-compatible `modelSettings.reasoning` block |
| Unprofiled models | ❌ (conservative default) | add a profile entry to opt in |

**Model profiles** are matched by **family prefix** against the configured model id, case-insensitive. You do not need to update the profile map every time a provider releases a minor version — any model id that starts with a known family prefix automatically inherits that family's profile.

| Family prefix | Example model ids that match | Profile applied |
|---|---|---|
| `claude-opus` | `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-5`, `claude-opus-3` | reasoning / high |
| `claude-sonnet` | `claude-sonnet-3-5`, `claude-sonnet-4-5`, `claude-sonnet-5` | standard / medium |
| `gpt-5` | `gpt-5`, `gpt-5-codex`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3`, `gpt-5.4`, `gpt-5-turbo` | reasoning / medium |
| `MiniMax-M2` | `MiniMax-M2`, `MiniMax-M2.1`, `MiniMax-M2.7`, `minimax-m2.5` | standard / low |
| *(anything else)* | e.g. `llama-3`, `qwen-2.5`, `deepseek-r1` | DEFAULT: standard / medium, `supportsEffort: false` |

Matching rules:
- **Longest prefix wins** — if both `gpt-5` and `gpt-5-codex` were registered as families, a model id of `gpt-5-codex-mini` would match `gpt-5-codex` first.
- **Case-insensitive** — `CLAUDE-OPUS-4-6` matches `claude-opus`.
- **Non-canonical forms fall through** — an id like `opus-4-6` (missing the `claude-` prefix) or `gpt.5.3` (dot instead of hyphen) will not match any family and hits the default profile. Stick to the canonical hyphen-separated form in your config.
- **To add a new family**, edit `MODEL_PROFILES` in `@scope/multi-model-agent-core/routing/model-profiles`. One entry covers every present and future minor version of that family.

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
| `baseUrl` | `string` | API base URL (required for `openai-compatible`) |
| `apiKey` | `string` | API key literal. Prefer `apiKeyEnv` to avoid hardcoding secrets. |
| `apiKeyEnv` | `string` | Environment variable name for API key |
| `sandboxPolicy` | `"none" \| "cwd-only"` | Default sandbox policy |
| `hostedTools` | `string[]` | Hosted tools: `"web_search"`, `"image_generation"`, `"code_interpreter"` |
| `costTier` | `"free" \| "low" \| "medium" \| "high"` | Overrides the family default cost tier. Use `"free"` for flat-rate or self-hosted deployments so the routing recipe prefers them. |

## Development

```bash
npm run build        # TypeScript compile (both packages)
npm test             # Run all tests
npm run test:watch   # Watch mode
```

Requires Node >= 22.

### Project Structure

```
packages/
  core/               # @scope/multi-model-agent-core
    src/
      config/         # Zod schema and file loader (no auto-discovery)
      routing/        # Capabilities, model profiles, auto-selection
      runners/        # Provider runner implementations (internal)
      tools/          # Tool adapters and definitions (internal)
      auth/           # OAuth helpers (internal)
      types.ts        # Public types — TaskSpec, ProviderConfig, etc.
      provider.ts      # Provider factory
      run-tasks.ts     # Task orchestrator
      index.ts        # Public API re-exports
  mcp/                # @scope/multi-model-agent-mcp
    src/
      cli.ts          # MCP CLI with config discovery
      routing/        # Provider matrix rendering
      index.ts        # Public API: buildMcpServer, buildTaskSchema
tests/                # Mirror of src/, uses Vitest
```

### Core Public API

```typescript
import {
  loadConfigFromFile,   // async, path-only (no auto-discovery)
  parseConfig,          // sync, validates raw object
  createProvider,       // factory for a named provider
  runTasks,             // parallel task execution orchestrator
  getBaseCapabilities,  // static capability snapshot
  resolveTaskCapabilities, // runtime capabilities with task overrides
  findModelProfile,     // model family profile lookup
  getEffectiveCostTier, // cost tier with config override
  selectProviderForTask, // auto-routing algorithm
  getProviderEligibility, // per-provider eligibility report
} from '@scope/multi-model-agent-core';
```

## License

ISC
