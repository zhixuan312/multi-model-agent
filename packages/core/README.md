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

// Uses the same ~/.multi-model/config.json as the standalone daemon —
// agents.standard, agents.complex, defaults.parentModel, etc.
const config = await loadConfigFromFile();

const results = await runTasks([
  { prompt: 'Refactor auth.ts to use JWT.',         agentType: 'complex' },
  { prompt: 'Write unit tests for auth module.',    agentType: 'standard' },
], config);

for (const r of results) {
  console.log(r.status, r.usage.costUSD, r.savedCostUSD, r.output);
}
```

`savedCostUSD` is populated when `defaults.parentModel` is set in the config — it's the difference between the agent's actual cost and what the parent model would have charged for the same input/output token count. Use it to surface a `$X saved (Y× ROI)` figure in your own UI.

## What's inside

- **Provider runners** — Claude, Codex, and any OpenAI-compatible endpoint
- **Routing engine** — capability filter → agent type → cheapest qualifier
- **`runTasks`** — parallel dispatch, returns per-task results with usage, cost, files touched, status, and escalation log
- **Reviewed lifecycle** — spec review + quality review by a different agent, auto-commit of file changes, file artifact verification
- **Executors** — pure `execute<Tool>(ctx, input)` functions for delegate, audit, review, verify, debug, execute-plan, retry, investigate (used by the HTTP server package)
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
| `./intake/compilers/*` | Route compilers: `delegate`, `review`, `debug`, `verify`, `audit`, `execute-plan`, `investigate` |
| `./reporting/parse-investigation-report` | `parseInvestigationReport`, `parseCitations`, `parseConfidence` (3.4.0) |
| `./auto-commit` | `autoCommitFiles` — git commit helper for worker file changes |
| `./file-artifact-check` | `partitionFilePaths`, `checkOutputTargets` — output target verification |
| `./telemetry/types` | `TelemetryEvent`, `UploadBatch`, `InstallMetadata` Zod schemas + `SCHEMA_VERSION` |
| `./telemetry/event-builder` | `buildTaskCompletedEvent`, `buildSessionStartedEvent`, etc. — pure event constructors |
| `./telemetry/consent-rules` | `decideConsent` — env / config / default precedence resolver |

## Diagnostic logging

Diagnostic logging and verbose streaming are both OFF by default.

```json
{
  "diagnostics": {
    "log": false,
    "verbose": false,
    "logDir": "/some/path"
  }
}
```

Two independent axes:

- **`diagnostics.log`** — when `true`, append JSONL records to `mmagent-YYYY-MM-DD.jsonl` under `diagnostics.logDir` (defaults to `~/.multi-model/logs/`).
- **`diagnostics.verbose`** — when `true`, the server emits per-tool-call, per-LLM-turn, per-stage-transition, and per-batch-lifecycle events. If `log` is also true, they're persisted; otherwise they stream only to the server's stderr.

CLI equivalents:

```bash
mmagent serve --verbose   # stream events to stderr (no file written)
mmagent serve --log       # persist to JSONL only (no stderr noise)
mmagent serve --verbose --log   # both
mmagent logs --follow --batch=<id>   # tail + filter
```

As of 3.4.0 every task-execution event the worker emits to the verbose stderr stream is also written to the JSONL log via a single `emit(TaskEvent)` writer — schema parity across both sinks. Crash/disconnect events (`startup`, `request_start`, `request_complete`, `shutdown`, `error`) are written unconditionally; per-task events (`heartbeat`, `stage_change`, `tool_call`, `turn_complete`, etc.) flow through the same writer.

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
