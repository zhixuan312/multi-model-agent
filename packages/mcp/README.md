# @zhixuan92/multi-model-agent-mcp

**Delegate work from your expensive parent-session model to a fleet of cheaper sub-agents, in parallel, from a single MCP tool call.**

This is the MCP stdio server for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent). Your MCP client (Claude Code, Claude Desktop, Codex CLI, Cursor, …) spawns it on demand and gets nine tools: `delegate_tasks`, `register_context_block`, `retry_tasks`, `get_batch_slice`, `execute_plan_task`, `audit_document`, `debug_task`, `review_code`, and `verify_work`. Each `delegate_tasks` call runs the supplied tasks in parallel across the agents you configured, auto-routing each to the cheapest one that has the required capabilities and agent type — or pinning to a specific agent when you want control. Every response envelope carries a pre-computed `headline` field so the calling agent can narrate the ROI story in one line without any arithmetic.

## Why use it

- **Cut cost and context.** Mechanical work (file edits, search, doc lookups) runs on cheap agents in a clean worker context. Your parent session's window stays lean and its judgment unblocked.
- **Run tasks in parallel.** Independent tasks in one call execute concurrently; wall-clock time drops with task count.
- **Mix agents in one config.** Claude, Codex, and any OpenAI-compatible endpoint (MiniMax, DeepSeek, Groq, local vLLM, …) live side-by-side.
- **Auto-route and escalate.** Capability filter → agent type routing; on failure the chain is walked automatically, stopping at the first success.
- **No bare failures.** Every termination path (incomplete, max_turns, timeout, error) populates `output` from the runner's scratchpad.
- **Sandboxed by default.** `cwd-only` file tool confinement and shell-disabled by default. Opt out per-task only when needed.
- **Pre-computed ROI headline**: every `delegate_tasks` response carries a `headline` field — a one-line summary of tasks, success rate, wall-clock, serial savings, cost, and ROI. Quote it verbatim; no arithmetic required.
- **Visible ROI.** Every response surfaces `aggregateCost`, `timings`, and per-task `savedCostUSD` for delegation savings.

## How it works

You don't run this server yourself. Your MCP client spawns it over stdio whenever a session starts, using the config snippets below. No install step, no long-running process to manage — `npx` fetches the latest version on demand each time.

Requires Node `>= 22`.

## Configure

Create `~/.multi-model/config.json`:

```json
{
  "agents": {
    "standard": {
      "type": "openai-compatible",
      "model": "claude-sonnet-4-6",
      "baseUrl": "https://api.claude.ai/v1"
    },
    "complex": {
      "type": "openai-compatible",
      "model": "claude-opus-4-6",
      "baseUrl": "https://api.claude.ai/v1"
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

Agent auth:

- **OpenAI-compatible** agents use `apiKeyEnv` (preferred) or inline `apiKey`
- **Claude** agents use `ANTHROPIC_API_KEY` if set, otherwise the local Claude auth flow

## Setup

### Claude Code

One command — the client will spawn the server on demand. Use `-s user` so the server is available in **every** project on your machine, not just the directory where you ran the command:

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

If your agents need environment variables:

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

Only set the env keys for the agents you actually configured. If you use `codex login`, the `codex` agent inside `multi-model-agent` reuses that auth automatically — but Claude, MiniMax, and other API-key agents still need to be passed through `[mcp_servers.multi-model-agent.env]` because the spawned MCP process does not inherit your shell environment. Restart `codex` after editing the file.

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

Claude Code's native `Task` / `Agent` subagents inherit your parent session's expensive model and eat its context window. We ship a drop-in rule file that teaches Claude Code **when** to delegate work through `delegate_tasks` instead — mechanical edits go to free agents, reasoning-tier work escalates only when needed, and independent tasks run in parallel.

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

Per-task fields: `prompt`, `tier`, `requiredCapabilities`, `provider?`, `tools?`, `maxTurns?`, `timeoutMs?`, `cwd?`, `effort?`, `sandboxPolicy?`, `contextBlockIds?`, `expectedCoverage?`, `includeProgressTrace?`, `parentModel?`, `skipCompletionHeuristic?`.

`expectedCoverage` supports `minSections?`, `sectionPattern?`, and `requiredMarkers?`. `includeProgressTrace` opts a task into returning its bounded post-hoc progress trace. `parentModel` lets the server estimate `savedCostUSD` relative to the calling model. `skipCompletionHeuristic: true` disables the short-output completion heuristic in the runner's supervision layer — use for tight-format outputs (single-line verdicts, CSV rows, opaque identifiers) that don't follow prose conventions. The `empty` and `thinking_only` degeneracy checks still fire independently. If you also set `expectedCoverage`, the coverage contract is authoritative and the short-output heuristic is automatically skipped on coverage pass — you don't need both.

Capabilities: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`.

### ROI headline

Every `delegate_tasks` response envelope — both `full` mode and `summary` mode — carries a pre-computed `headline` field: a one-line summary of tasks / success rate / wall-clock / serial-savings / actual cost / saved cost / ROI multiplier (when a single baseline is declared). The calling agent is expected to quote it verbatim to the user after every dispatch, with no arithmetic. Example:

> *"11 tasks, 5/11 ok (45.5%), wall 5m 54s, saved ~18m 30s vs serial, $1.37 actual / $8.91 saved vs claude-opus-4-6 (7.5x ROI)"*

When a batch declares mixed parent models across its tasks, the ROI multiplier is suppressed (because a single ratio across different baselines is not coherent) and the cost clause reads `$X actual / $Y saved vs multiple baselines`. When no `parentModel` is declared, the cost clause collapses to `$X actual`.

If the primary response came back via summary mode or a client-side limit obscured the envelope, call `get_batch_slice({ batchId, slice: 'telemetry' })` — it returns the same `headline` plus the envelope with a ~600-byte header and ~200 bytes per task in `results[]`. A typical 10–30-task batch comes back at 2–7 KB, well under the client's tool-result size limit; very large batches (100+ tasks) scale linearly and may approach the limit.

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
