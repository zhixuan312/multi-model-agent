# @zhixuan92/multi-model-agent-core

**Runtime library for multi-model-agent.** Import it to run multi-provider agent tasks directly from your own Node program — same routing, supervision, and review pipeline, no MCP client needed.

> **Just want your AI assistant to delegate work?** Install [`@zhixuan92/multi-model-agent-mcp`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent-mcp) instead — it wraps this library in an MCP server.

## Install

```bash
npm install @zhixuan92/multi-model-agent-core
```

Requires Node >= 22. ESM only.

## Quick example

```ts
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config = await loadConfigFromFile();

const results = await runTasks([
  { prompt: 'Refactor auth.ts to use JWT.', agentType: 'complex' },
  { prompt: 'Write unit tests for auth module.', agentType: 'standard' },
], config);

for (const r of results) {
  console.log(r.status, r.usage.costUSD, r.output);
}
```

## What's inside

- **Provider runners** — Claude, Codex, and any OpenAI-compatible endpoint
- **Routing engine** — capability filter → agent type → cheapest qualifier
- **`runTasks`** — parallel dispatch, returns per-task results with usage, cost, files touched, status, and escalation log
- **Reviewed lifecycle** — spec review + quality review by a different agent
- **Config schema** — Zod-validated, same contract as the MCP server
- **Sandboxed tools** — `readFile`, `writeFile`, `grep`, `glob`, `listFiles`, `runShell` with `cwd-only` confinement

## Subpath exports

| Subpath | What |
|---|---|
| `./config/schema` | `parseConfig`, `multiModelConfigSchema` |
| `./config/load` | `loadConfigFromFile` |
| `./routing/resolve-agent` | `resolveAgent` — resolves agent type to provider |
| `./routing/model-profiles` | Model cost/tier profiles |
| `./provider` | `createProvider` factory |
| `./run-tasks` | `runTasks` parallel dispatcher, `RunTasksOptions` |
| `./heartbeat` | `HeartbeatTimer` — periodic progress heartbeat emitter |
| `./types` | All shared types |
| `./intake/pipeline` | `runIntakePipeline` — compile → infer → classify → resolve |
| `./intake/types` | `DraftTask`, `Source`, `IntakeResult`, `ClarificationEntry` |
| `./intake/classify` | `classifyDraft` — deterministic classification heuristic |
| `./intake/confirm` | `processConfirmations` — clarification resume processing |
| `./intake/clarification-store` | `ClarificationStore` — TTL/LRU state for clarification sets |
| `./intake/compilers/*` | Route compilers: `delegate`, `review`, `debug`, `verify`, `audit` |

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
