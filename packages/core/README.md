# @zhixuan92/multi-model-agent-core

**Runtime library for multi-model-agent.** Import it to run multi-provider agent tasks directly from your own Node program — same routing, supervision, and review pipeline, without the HTTP server.

> **Want the standalone service instead?** Install [`@zhixuan92/multi-model-agent`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent) — it wraps this library in a local HTTP daemon with client-installable skills for Claude Code, Gemini CLI, Codex CLI, and Cursor.

## Install

```bash
npm install @zhixuan92/multi-model-agent-core
```

Requires Node >= 22. ESM only.

## Quick example

The primary way to run tasks is the standalone HTTP service
([`@zhixuan92/multi-model-agent`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)),
which wraps this library and exposes `delegate`, `audit`, `review`, `debug`, etc. over HTTP
with client-installable skills.

To embed the pipeline directly, load the shared config and drive a tool through `executeTask`
(see "v4 Engine API" below — it takes the tool's `ToolConfig`, an `ExecutionContext`, and the
tool input, and returns the uniform `ExecutorOutput` envelope):

```ts
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';

// Uses the same ~/.multi-model/config.json as the standalone daemon —
// agents.standard, agents.complex, etc.
const config = await loadConfigFromFile();
```

Each per-task result carries `cost.costDeltaVsMainUSD` when `mainModel` is set on the task —
it's `actualCost − mainCost` (negative = worker cheaper/savings). Use it to surface a
`$X saved (Y× ROI)` figure in your own UI. (4.0.3 rename: was `costDeltaVsParentUSD`.)

## What's inside

- **Provider runners** — Claude, Codex, and any OpenAI-compatible endpoint
- **Routing engine** — capability filter → agent type → cheapest qualifier
- **`executeTask`** — drives a tool (delegate, audit, review, …) end-to-end: brief compilation, parallel dispatch, review/rework, and a uniform per-task result envelope with usage, cost, files touched, status, and escalation log
- **Reviewed lifecycle** — parallel spec + quality lint review by a different tier, conditional rework when verdicts demand changes, annotator-scored commit gate, file artifact verification
- **Executors** — pure `execute<Tool>(ctx, input)` functions for delegate, audit, review, debug, execute-plan, retry, investigate, research (used by the HTTP server package)
- **Tool schemas** — Zod-validated input shapes for each tool, exportable via `./tool-schemas/*`
- **BatchRegistry** — server-wide state machine for pending / awaiting_clarification / complete / failed / expired batches with context-block refcount pinning
- **Sandboxed tools** — `readFile`, `writeFile`, `grep`, `glob`, `listFiles`, `runShell` with `cwd-only` confinement

## v4 Engine API

The v4 release runs reviews through the lifecycle handlers in `packages/core/src/lifecycle/handlers/` — `review-stage.ts` drives spec + quality review and `rework-stage.ts` drives the rework loop. These handlers are internal to the lifecycle pipeline and are not exposed as a standalone public engine class. To run a complete task end-to-end, call `executeTask` (below); review + rework fire automatically based on the tool's category and the configured `reviewPolicy`.

### executeTask (generic task executor)

A single generic orchestrator (`≤ 200 LOC`) that replaces per-tool executor files. Driven by a `ToolConfig` object that encodes all tool-specific behavior:

```
briefSlot → resolveAgent → buildTaskSpec → dispatch → autoRegisterContextBlock
  → computeTimings/cost → parseReport → composeHeadline → mapVerdicts
```

```ts
import { executeTask } from '@zhixuan92/multi-model-agent-core/lifecycle/task-executor';
import { toolConfig } from '@zhixuan92/multi-model-agent-core/tools/delegate/tool-config';

const output = await executeTask(toolConfig, ctx, input);
// output → ExecutorOutput { headline, results, batchTimings, costSummary, structuredReport, ... }
```

### ToolConfig

Per-tool configuration interface that drives `executeTask`. Each tool exports its own `toolConfig` constant.

```ts
interface ToolConfig<Input, Brief, Report> {
  name: string;                                              // tool name
  category: 'artifact_producing' | 'read_only' | 'assist';
  agentType: AgentType;                                      // 'standard' | 'complex'
  briefSlot: BriefSlotFiller<Input, Brief[]>;                // input → briefs
  buildTaskSpec: (brief: Brief, ctx: ExecutionContext) => TaskSpec;
  reportSchema: ReportSchema<Report>;                        // Zod schema for structured output
  headlineTemplate: HeadlineTemplate;                        // compose headline from result
  postProcessEnvelope?: (envelope, ctx) => any;              // optional envelope post-processing
}
```

Each tool's config lives at `@zhixuan92/multi-model-agent-core/tools/<tool>/tool-config`:

| Tool | Subpath |
|---|---|
| delegate | `./tools/delegate/tool-config` |
| review | `./tools/review/tool-config` |
| audit | `./tools/audit/tool-config` |
| debug | `./tools/debug/tool-config` |
| investigate | `./tools/investigate/tool-config` |
| research | `./tools/research/tool-config` |
| execute-plan | `./tools/execute-plan/tool-config` |
| retry | `./tools/retry/tool-config` |
| register-context-block | `./tools/register-context-block/tool-config` |

## Subpath exports

| Subpath | What |
|---|---|
| `./config/schema` | `parseConfig`, `multiModelConfigSchema`, `serverConfigSchema` |
| `./config/load` | `loadConfigFromFile`, `loadAuthToken` |
| `./routing/resolve-agent` | `resolveAgent` — resolves agent type to provider |
| `./routing/model-profiles` | Model cost/tier profiles |
| `./provider` | `createProvider` factory |
| `./heartbeat` | `HeartbeatTimer` — periodic progress heartbeat emitter |
| `./types` | All shared types |
| `./executors` | Pure `execute<Tool>(ctx, input)` functions and `ExecutionContext` type |
| `./tool-schemas` | Zod input/output schemas for each tool |
| `./intake/pipeline` | `runIntakePipeline` — compile → infer → classify → resolve |
| `./intake/types` | `DraftTask`, `Source`, `IntakeResult`, `ClarificationEntry` |
| `./intake/classify` | `classifyDraft` — deterministic classification heuristic |
| `./intake/confirm` | `processConfirmations` — clarification resume processing |
| `./intake/clarification-store` | `ClarificationStore` — TTL/LRU state for clarification sets |
| `./intake/compilers/*` | Route compilers: `delegate`, `review`, `debug`, `audit`, `execute-plan`, `investigate`, `research` |
| `./reporting/parse-investigation-report` | `parseInvestigationReport`, `parseCitations`, `parseConfidence` (3.4.0) |
| `./auto-commit` | `autoCommitFiles` — git commit helper for worker file changes |
| `./file-artifact-check` | `partitionFilePaths`, `checkOutputTargets` — output target verification |
| `./telemetry/types` | `TelemetryEvent`, `UploadBatch`, `InstallMetadata` Zod schemas + `SCHEMA_VERSION` |
| `./telemetry/event-builder` | `buildTaskCompletedEvent`, `buildSessionStartedEvent`, etc. — pure event constructors |
| `./telemetry/consent-rules` | `decideConsent` — env / config / default precedence resolver |
| `./lifecycle/task-executor` | `executeTask` — generic per-tool orchestrator driven by a `ToolConfig` |
| `./lifecycle/executor-output-types` | `ExecutorOutput`, `BatchTimings`, `BatchAggregateCost` |
| `./tools/<tool>/tool-config` | Per-tool `ToolConfig` objects (delegate, review, audit, debug, investigate, research, execute-plan, retry, register-context-block) |

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

## What's new in 4.7.12

- **Transport component reduced to one implementation.** `HTTPListener` is now the sole HTTP listener (the server no longer creates `node:http` inline) and owns only the socket lifecycle; drain authority lives solely in the request pipeline. A rejected request-handler promise is now logged and answered with `500` instead of being silently swallowed.
- **Host-header rebinding guard is live.** Every request's `Host` header must be a literal loopback form; a foreign host (DNS-rebinding attempt) is rejected with `403 forbidden_host`.
- **Dead surface removed.** `RouteDispatcher` response-shape metadata (`RouteMetadata`/`ResponseShape`), `HTTPListener` drain/start-time methods, 15 unused enums, `draft-task.ts`, and `FallbackOverride` are gone; config types are now derived from the Zod schema.

Full history: [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
