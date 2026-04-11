# multi-model-agent

**Delegate work from your expensive parent-session model to a fleet of cheaper sub-agents, in parallel, from a single MCP tool call.**

Running everything on one high-end model (Opus, GPT-5, etc.) is slow, expensive, and fills your session's context window with mechanical labor. `multi-model-agent` is an MCP server that gives your client a single tool, `delegate_tasks`, which runs those tasks in parallel across the providers you configure — auto-routing each task to the cheapest provider that has the required capabilities and quality tier, or pinning to a specific provider when you want control.

## Why use it

- **Cut cost and context.** Mechanical work (file edits, search, tests, doc lookups) runs on cheap providers in a clean worker context. Your parent session keeps its window lean and its judgment unblocked.
- **Run tasks in parallel.** Independent tasks in one call execute concurrently — wall-clock time drops linearly with task count.
- **Mix providers in one config.** Claude, Codex (via `codex login` or `OPENAI_API_KEY`), and any OpenAI-compatible endpoint (MiniMax, DeepSeek, Groq, local vLLM, …) live side-by-side.
- **Auto-route by capability + tier + cost.** Declare what the task needs; the server picks the cheapest qualifying provider and walks the escalation chain on failure.
- **Sandboxed by default.** Every delegated sub-agent is confined to the task's working directory until you opt out. Shell is off by default.
- **Visible ROI.** Every response includes `aggregateCost`, `timings`, and per-task `savedCostUSD` so you can see the savings without computing anything.

## What you get

Six MCP tools:

| Tool | Purpose |
| --- | --- |
| `delegate_tasks` | Dispatch an array of tasks; each runs on the cheapest qualifying provider, in parallel. Every response carries a pre-computed `headline` field with the one-line ROI summary. |
| `register_context_block` | Store a long brief once and reference it by id on subsequent dispatches. |
| `retry_tasks` | Re-run specific task indices from a previous batch without re-sending briefs (30-minute LRU cache). |
| `get_task_output` | Fetch the full text of a single task result from a `summary`-mode batch. |
| `get_task_detail` | Fetch per-task execution metadata (`toolCalls`, `filesRead/Written/Listed`, full `escalationLog` with reasons, `progressTrace` if opted in) for a single task from a previous batch. |
| `get_batch_telemetry` | Fetch a compact ROI telemetry envelope for a previous batch — `headline`, `timings`, `batchProgress`, `aggregateCost`, and a per-task cost/timing rollup. Use as a fallback when the primary response was obscured by a client-side size limit. Sizing is linear per task rather than capped. |

Three provider types:

- `claude` — via `@anthropic-ai/claude-agent-sdk`
- `codex` — OpenAI Responses API with `codex login` or `OPENAI_API_KEY`
- `openai-compatible` — any OpenAI-compatible endpoint (`baseUrl` + `apiKey`/`apiKeyEnv`)

Routing axes:

- required capabilities (`file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`)
- quality tier (`trivial`, `standard`, `reasoning`)
- cost tier (`free`, `low`, `medium`, `high`)

Plus: optional per-task filesystem sandboxing, response pagination (`responseMode`), enumerable-deliverable coverage validation (`expectedCoverage`), and bounded post-hoc progress traces (`includeProgressTrace`).

## Packages

This repo contains two workspace packages:

| Package | Purpose |
| --- | --- |
| `@zhixuan92/multi-model-agent-core` | Routing, config loading, provider runners, task execution |
| `@zhixuan92/multi-model-agent-mcp` | MCP stdio server exposing `delegate_tasks` |

## Quick Start

### 1. Requirements

- Node.js `>=22`
- An MCP client such as Claude Code, Claude Desktop, Codex CLI, or Cursor
- Credentials for at least one provider

Provider auth currently works like this:

- `codex`: uses `codex login` if available, otherwise `OPENAI_API_KEY`
- `claude`: uses `ANTHROPIC_API_KEY` if set, otherwise Claude's existing auth flow on the machine
- `openai-compatible`: uses `apiKey` or `apiKeyEnv` from your config

### 2. How the server runs

You don't start the server yourself. Your MCP client (Claude Code, Claude Desktop, Cursor, …) spawns it over stdio on demand using the `npx` command in step 4 below — no install step, no long-running process to manage. `npx` fetches the latest published version each time.

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

### Security best practices

- **Never commit API keys.** Always use `apiKeyEnv` and set the value via your shell or MCP client config. The server logs a warning at config-load time if it sees an inline `apiKey`.
- **Restrict file permissions** on anything holding a token:
  ```bash
  chmod 600 ~/.multi-model/config.json
  chmod 600 ~/.codex/auth.json
  ```
  The Codex runner emits a warning the first time it reads `~/.codex/auth.json` if the file is group- or world-readable.
- **Keep `sandboxPolicy: cwd-only`** unless a task genuinely needs to run shell commands or touch files outside the working directory. `cwd-only` confines file tools to the task's `cwd` and disables `runShell` entirely.
- **Do not enable `CODEX_DEBUG=1` in environments that ship logs anywhere.** Debug mode dumps raw request/response bodies (prompts, file contents, tool arguments) to stderr. The server prints a warning at startup when the flag is set.
- **File-tool size caps** — `readFile` rejects targets larger than 50 MiB and `writeFile` rejects content larger than 100 MiB. These caps stop a runaway sub-agent from OOMing the host or filling the disk.

### Sandbox enforcement

The default `sandboxPolicy: "cwd-only"` confines every delegated sub-agent to the task's working directory. Enforcement lives in the core `assertWithinCwd` helper and runs per-call inside every file tool. Errors are surfaced to the model as tool errors, so the model can retry with a corrected path rather than silently failing.

1. **File reads** are allowed only inside `cwd` and its descendants. Path traversal (`../`, absolute paths outside `cwd`) is rejected.
2. **File writes** are subject to the same restriction.
3. **Symlink resolution uses `fs.realpath`.** A symlink inside `cwd` that points outside `cwd` is treated as outside and rejected — the check runs on the resolved real path, not the literal path.
4. **Nonexistent target paths** resolve by walking back to the nearest existing ancestor and re-applying the check, so symlinks in ancestor directories are still caught.
5. **`runShell` is hard-disabled** under `cwd-only`. The tool returns an error telling the model to use `readFile` / `writeFile` / `grep` / `glob` / `listFiles` instead.
6. **The check is per-call**, not per-session. Every tool invocation re-validates.
7. **Errors are surfaced to the model**, not silently swallowed. The model observes the rejection in its tool result and can adjust.

Set `sandboxPolicy: "none"` per-provider or per-task only when you intentionally want shell access or cross-repo writes. The `shell` capability only appears in a provider's capability set when its effective sandbox policy is `"none"`, so auto-routing will not accidentally route shell work into a sandboxed worker.

### 4. Register the MCP server

You don't install or run a binary yourself. Each MCP client spawns the server over stdio using the `npx` command below. Pick the client(s) you use:

#### Claude Code

Register at **user scope** (`-s user`) so the server is available in every directory, not just the one you ran the command in:

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

If your providers need environment variables, pass them with `-e`:

```bash
claude mcp add multi-model-agent -s user \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e MINIMAX_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

Claude Code supports three MCP scopes:

| Scope | Availability |
| --- | --- |
| `local` (default) | Only the project where you ran `claude mcp add` |
| `project` | Shared with collaborators via a committed `.mcp.json` |
| `user` | All projects on your machine — recommended for this server |

If you already added it at local scope and want it everywhere, remove and re-add:

```bash
claude mcp remove multi-model-agent -s local
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

#### Codex CLI

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

Only include the env keys for the providers you configured in `~/.multi-model/config.json`. Restart `codex` after editing the file.

> **Tip:** if you are already logged in via `codex login`, the `codex` provider inside `multi-model-agent` will reuse that auth automatically and you don't need `OPENAI_API_KEY` in the env block — but any *other* providers that need an API key (Claude, MiniMax, etc.) still must be passed through the env block because the spawned MCP server doesn't inherit your shell environment.

#### Claude Desktop

Add this to `claude_desktop_config.json`:

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

## Updating

The `npx -y @zhixuan92/multi-model-agent-mcp serve` command in every install recipe above **always fetches the latest published version** on each spawn (that is what `-y` does). You do not need to run `npm update` or re-register the server to pick up a new release.

To apply an update:

1. **Quit your MCP client fully** (Claude Code, Claude Desktop, Codex CLI). Just closing the window is not always enough — on macOS, use *Quit* from the menu or `⌘Q`. Claude Code sessions keep the MCP server process alive until the session ends.
2. Restart the client. On the next `delegate_tasks` call, `npx` will fetch the latest version from npm.
3. Optional: clear npm's cached npx executables with `npx clear-npx-cache` if you suspect a stale build. Rarely needed.

### Pinning a version

If you want reproducibility (CI, shared team config, debugging a regression), pin a specific version in the spawn command:

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp@0.3.0 serve
```

or in `config.toml` / `claude_desktop_config.json`:

```toml
args = ["-y", "@zhixuan92/multi-model-agent-mcp@0.3.0", "serve"]
```

Replace `0.3.0` with any published version. Without an explicit version tag, `npx` follows the `latest` dist-tag.

### Breaking changes and migration

The project is on **0.x semver**: any MINOR bump (`0.2.x → 0.3.0`) may change the config schema, the `delegate_tasks` tool input, or provider defaults. PATCH bumps (`0.3.0 → 0.3.1`) are strictly backwards-compatible bug fixes.

Always skim [`CHANGELOG.md`](./CHANGELOG.md) before picking up a new MINOR version. If the changelog calls out a config or tool-input change, update `~/.multi-model/config.json` (and any stored `delegate_tasks` call shapes in rules/prompts) before restarting your client. Provider auth, `~/.multi-model/config.json` location, and the MCP tool names themselves are stable across all 0.x releases.

## Recommended: Delegation Rule for Claude Code

Claude Code's native `Task` / `Agent` subagents inherit your parent session's expensive model and eat its context window. We ship a drop-in rule file that teaches Claude Code **when** to delegate work through `delegate_tasks` instead — mechanical edits go to free providers, reasoning-tier work goes to expensive providers only when needed, and independent tasks run in parallel.

Install globally with:

```bash
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

Then restart Claude Code. The full rule — install options, scope (what to delegate vs. keep native), provider routing table, dispatch examples, and status handling — lives in [`docs/claude-code-delegation-rule.md`](./docs/claude-code-delegation-rule.md). Read that file for the complete version before adjusting it to your own provider names.

**Superpowers users:** the rule pairs with `superpowers:writing-plans`. Specific per-task scope (file paths, mechanical vs. integration vs. architectural, capabilities needed) lets the rule auto-route each task to the cheapest qualifying provider. Vague plans force escalation and cost more. See the *"Writing Delegable Briefs"* section of the rule file for examples.

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

`delegate_tasks` accepts an array of tasks and runs them concurrently. The response includes `batchId`, `mode` (full or summary), `timings`, `batchProgress`, and `aggregateCost`. Use `responseMode` to control pagination behavior.

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
| `contextBlockIds` | no | Array of context block ids from `register_context_block` |
| `expectedCoverage` | no | Declare coverage contract: `minSections`, `sectionPattern`, `requiredMarkers` |
| `includeProgressTrace` | no | Opt-in to bounded execution timeline capture in `progressTrace` |
| `parentModel` | no | Model id for `savedCostUSD` estimation (e.g. `claude-opus-4-6`) |

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
| `inputTokenSoftLimit` | all | Per-provider input token soft limit override |
| `inputCostPerMTok` | all | Override provider's input cost per million tokens |
| `outputCostPerMTok` | all | Override provider's output cost per million tokens |

## Other Tools

The MCP server exposes three additional tools alongside `delegate_tasks`:

- **`register_context_block`**: Store a content block under an id for reuse in later `delegate_tasks` calls via `contextBlockIds`. Avoids re-transmitting long briefs on every dispatch.
- **`retry_tasks`**: Re-run specific task indices from a previous batch without re-transmitting briefs. Batches are cached for 30 minutes (100-batch LRU cap).
- **`get_task_output`**: Fetch the full output of a specific task from a previous batch. Use when a batch returned in `summary` mode and you need the full text of one result.

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
npm run serve   # run the MCP server locally on stdio
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full contributor workflow, coding conventions, and how to add a new provider.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| `No providers configured` | Config file missing or empty | Create `~/.multi-model/config.json` or pass `--config` |
| Provider is never selected | Missing capability or insufficient tier | Check `requiredCapabilities`, `tier`, and your provider config |
| `shell` tasks fail | Sandbox is still `cwd-only` | Set provider or task `sandboxPolicy` to `none` |
| `openai-compatible` provider fails to start | `baseUrl` missing in provider config | Add `baseUrl` (and `apiKey` or `apiKeyEnv`) to the provider entry |
| Codex auth fails | No local Codex login and no `OPENAI_API_KEY` | Run `codex login` or set `OPENAI_API_KEY` |
| MCP client does not see changes | Client not restarted | Fully quit and reopen the client |

## License

MIT — see [`LICENSE`](./LICENSE).
