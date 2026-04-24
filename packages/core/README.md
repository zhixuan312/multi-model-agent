# @zhixuan92/multi-model-agent-core

**Runtime library for multi-model-agent.** Import it to run multi-provider agent tasks directly from your own Node program — same routing, supervision, and review pipeline, without the HTTP server.

> **Want the standalone service instead?** Install [`@zhixuan92/multi-model-agent`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent) — it wraps this library in a local HTTP daemon with client-installable skills for Claude Code, Gemini CLI, Codex CLI, and Cursor.

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
- **Reviewed lifecycle** — spec review + quality review by a different agent, auto-commit of file changes, file artifact verification
- **Executors** — pure `execute<Tool>(ctx, input)` functions for delegate, audit, review, verify, debug, execute-plan, retry (used by the HTTP server package)
- **Tool schemas** — Zod-validated input shapes for each tool, exportable via `./tool-schemas/*`
- **BatchRegistry** — server-wide state machine for pending / awaiting_clarification / complete / failed / expired batches with context-block refcount pinning
- **Sandboxed tools** — `readFile`, `writeFile`, `grep`, `glob`, `listFiles`, `runShell` with `cwd-only` confinement

## Subpath exports

| Subpath | What |
|---|---|
| `./config/schema` | `parseConfig`, `multiModelConfigSchema`, `serverConfigSchema` |
| `./config/load` | `loadConfigFromFile`, `loadAuthToken` |
| `./routing/resolve-agent` | `resolveAgent` — resolves agent type to provider |
| `./routing/model-profiles` | Model cost/tier profiles |
| `./provider` | `createProvider` factory |
| `./run-tasks` | `runTasks` parallel dispatcher, `RunTasksOptions` |
| `./heartbeat` | `HeartbeatTimer` — periodic progress heartbeat emitter |
| `./types` | All shared types |
| `./executors` | Pure `execute<Tool>(ctx, input)` functions and `ExecutionContext` type |
| `./tool-schemas` | Zod input/output schemas for each tool |
| `./intake/pipeline` | `runIntakePipeline` — compile → infer → classify → resolve |
| `./intake/types` | `DraftTask`, `Source`, `IntakeResult`, `ClarificationEntry` |
| `./intake/classify` | `classifyDraft` — deterministic classification heuristic |
| `./intake/confirm` | `processConfirmations` — clarification resume processing |
| `./intake/clarification-store` | `ClarificationStore` — TTL/LRU state for clarification sets |
| `./intake/compilers/*` | Route compilers: `delegate`, `review`, `debug`, `verify`, `audit`, `execute-plan` |
| `./auto-commit` | `autoCommitFiles` — git commit helper for worker file changes |
| `./file-artifact-check` | `partitionFilePaths`, `checkOutputTargets` — output target verification |

## Diagnostic logging

Diagnostic logging is OFF by default.

It stays disabled when the `diagnostics` block is absent or when `diagnostics.log` is `false` in `~/.multi-model/config.json`.

Enable it by adding this minimal config:

```json
{
  "diagnostics": { "log": true }
}
```

Optionally set `diagnostics.logDir` to override the default log directory:

```json
{
  "diagnostics": {
    "log": true,
    "logDir": "/some/path"
  }
}
```

When `diagnostics.logDir` is omitted, logs default to `~/.multi-model/logs/`.

When enabled, the diagnostic logger appends JSONL records to `mmagent-YYYY-MM-DD.jsonl` in append mode.

Only crash/disconnect diagnostic events are logged: `startup`, `request_start`, `request_complete`, `shutdown`, and `error`. This is a crash-diagnosis log, not a progress feed.

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
