# multi-model-agent

**A fleet of sub-agents, one tool call, zero context pollution.**

Running everything on your main agent (Opus, GPT-5, etc.) is slow, expensive, and fills your context window with mechanical labor. `multi-model-agent` is an MCP server that gives your client a single tool, `delegate_tasks`, which runs tasks in parallel across a fleet of cheaper workers — auto-routing each one to the right slot, enforcing cost ceilings, and surfacing structured reports.

## Three Pillars of v1.0.0

### 1. Cross-model blind spot detection
The **readiness check** (phase 1) evaluates every brief before dispatch. It catches vague prompts, under-specified scopes, and contextually undersupplied requests — surfacing `briefQualityWarnings` in the result so the caller knows what to improve. By default (`briefQualityPolicy: 'warn'`), warnings are surfaced but dispatch proceeds. Set `'strict'` to refuse vague briefs before money is spent, or `'normalize'` to auto-enrich them.

### 2. Two-slot agent model
Every task routes to one of two slots:

| Slot | When to use it | Speed | Cost |
|---|---|---|---|
| `standard` | Mechanical work, retrievals, single-file edits, focused research | Fast | Cheap |
| `complex` | Multi-file integration, architecture decisions, security review, whole-branch synthesis | Slow | Higher |

The server picks the cheapest configured agent that satisfies the task's required capabilities and declared `agentType`.

### 3. Superpowers specialization
Four tools beyond basic dispatch — each one is a specialized sub-routine with opinionated defaults:

| Tool | Purpose |
|---|---|
| `audit_document` | Verify a spec document's requirements are met |
| `debug_task` | Triage a failure against known failure patterns |
| `review_code` | Structural quality review of a diff or module |
| `verify_work` | Confirm implementation matches spec |

## Eight Tools

The MCP server exposes eight tools:

| Tool | Purpose |
|---|---|
| `delegate_tasks` | Dispatch a batch of tasks; concurrent execution, auto-routing, cost ceiling |
| `register_context_block` | Store a reusable context block (long briefs, evidence bundles) |
| `retry_tasks` | Re-dispatch specific tasks from a batch (30-min LRU cache) |
| `get_batch_slice` | Fetch output, detail, or telemetry from a previous batch |
| `audit_document` | Specialized: spec compliance audit |
| `debug_task` | Specialized: failure triage |
| `review_code` | Specialized: code quality review |
| `verify_work` | Specialized: implementation verification |

## Five-Phase Lifecycle

```
Brief → Readiness check → Dispatch → Execute → Review (if enabled) → Aggregate
```

### Phase 1 — Brief / Readiness check
`evaluateReadiness` runs on every brief before dispatch (default policy: `warn`). It detects missing pillars (scope, inputs, done condition, output contract) and layer-2 warnings (outsourced discovery, brittle line anchors, mixed environment actions). Results are surfaced as `briefQualityWarnings` on the task result.

| `briefQualityPolicy` | Behavior |
|---|---|
| `warn` (default) | Evaluate and surface warnings; dispatch proceeds |
| `strict` | Refuse briefs with missing pillars (`brief_too_vague` status) |
| `normalize` | Refuse if missing pillars; auto-enrich if layer-2 warnings |
| `off` | Skip readiness evaluation entirely |

### Phase 2 — Dispatch
Route to the appropriate agent slot (`standard` or `complex`) based on `agentType`. Auto-routing selects the cheapest configured agent that has the required capabilities.

### Phase 3 — Execute
The agent performs the work under enforced constraints:

- **Cost ceiling** — task aborts before spending more than the declared ceiling
- **Call cache** — repeated identical calls (same prompt + model) return the cached result
- **Format constraints** — structured output requirements declared via `expectedCoverage`

### Phase 4 — Review (optional)
Spec review and quality review run on the *other* slot — not the same slot that did the work. This prevents self-review bias.

### Phase 5 — Aggregate
Merge all per-agent reports into a single structured `BatchReport` with `headline`, `timings`, `aggregateCost`, `batchProgress`, and per-task cost rollup.

## Minimal Config

```json
{
  "agents": {
    "fast": {
      "agentType": "standard",
      "provider": "openai-compatible",
      "model": "MiniMax-M2",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "hostedTools": ["web_search"]
    },
    "reasoner": {
      "agentType": "complex",
      "provider": "openai-compatible",
      "model": "MiniMax-M2-32K",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY"
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

## Packages

| Package | Purpose |
|---|---|
| `@zhixuan92/multi-model-agent-core` | Routing, config loading, agent runners, execution |
| `@zhixuan92/multi-model-agent-mcp` | MCP stdio server exposing the nine tools |

## Quick Start

### 1. Requirements

- Node.js `>=22`
- An MCP client (Claude Code, Claude Desktop, Codex CLI, Cursor)
- Credentials for at least one provider

### 2. Create your config

```bash
mkdir -p ~/.multi-model
touch ~/.multi-model/config.json
# edit with the minimal config above
```

### 3. Register the MCP server

#### Claude Code (user scope)

```bash
claude mcp add multi-model-agent -s user -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

With env vars:

```bash
claude mcp add multi-model-agent -s user \
  -e MINIMAX_API_KEY=... \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.multi-model-agent]
command = "npx"
args = ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"]

[mcp_servers.multi-model-agent.env]
MINIMAX_API_KEY = "..."
```

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-model-agent": {
      "command": "npx",
      "args": ["-y", "@zhixuan92/multi-model-agent-mcp", "serve"],
      "env": { "MINIMAX_API_KEY": "..." }
    }
  }
}
```

### 4. Verify

```bash
claude mcp list
```

Test with a trivial task:

```json
{
  "tasks": [{
    "prompt": "Say hello.",
    "agentType": "standard",
    "requiredCapabilities": []
  }]
}
```

## Updating

`npx -y @zhixuan92/multi-model-agent-mcp serve` **always fetches the latest published version** on each spawn. To update:

1. Fully quit your MCP client (`⌘Q` on macOS)
2. Restart — the next `delegate_tasks` call pulls the new version

To pin a version:

```bash
# in spawn command
npx -y @zhixuan92/multi-model-agent-mcp@1.0.0 serve

# in config files
args = ["-y", "@zhixuan92/multi-model-agent-mcp@1.0.0", "serve"]
```

## Recommended: Delegation Rule for Claude Code

Install globally:

```bash
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

The rule teaches Claude Code **when** to delegate (judgment stays in parent, labor goes to the fleet) and **how** to brief workers for zero-decision execution. Full reference: [`docs/claude-code-delegation-rule.md`](./docs/claude-code-delegation-rule.md).

## Security Best Practices

- **Never commit API keys.** Use `apiKeyEnv` and set the value via your shell or MCP client config.
- **Restrict file permissions:**
  ```bash
  chmod 600 ~/.multi-model/config.json
  chmod 600 ~/.codex/auth.json
  ```
- **Keep `sandboxPolicy: cwd-only`** (default) unless a task genuinely needs shell access.
- **File size caps:** `readFile` rejects targets >50 MiB; `writeFile` rejects content >100 MiB.

## Local Development

```bash
npm install
npm run build
npm test
npm run serve   # MCP server on stdio
```

Repo layout:

- `packages/core` — routing, config, runners, execution
- `packages/mcp` — MCP stdio server and tool schema
- `tests` — Vitest coverage
- `scripts` — local helper scripts

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full contributor workflow.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `No agents configured` | Config file missing or empty | Create `~/.multi-model/config.json` or pass `--config` |
| Task never routes | Missing capability or wrong `agentType` | Check `requiredCapabilities` and `agentType` in your config |
| `shell` tasks fail | Sandbox is `cwd-only` | Set `sandboxPolicy: "none"` on the agent or task |
| `openai-compatible` fails | `baseUrl` missing | Add `baseUrl` + `apiKey`/`apiKeyEnv` to the agent entry |
| MCP client doesn't see changes | Client not restarted | Fully quit and reopen the client |

## License

MIT — see [`LICENSE`](./LICENSE).