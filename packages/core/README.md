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
// agents.standard, agents.complex, etc.
const config = await loadConfigFromFile();

const results = await runTasks([
  { prompt: 'Refactor auth.ts to use JWT.',         agentType: 'complex', mainModel: 'claude-opus-4-7' },
  { prompt: 'Write unit tests for auth module.',    agentType: 'standard', mainModel: 'claude-opus-4-7' },
], config);

for (const r of results) {
  console.log(r.status, r.cost?.costUSD, r.cost?.costDeltaVsMainUSD, r.output);
}
```

`costDeltaVsMainUSD` is populated when `mainModel` is set on the TaskSpec — it's `actualCost − mainCost` (negative = worker cheaper/savings). Use it to surface a `$X saved (Y× ROI)` figure in your own UI. (4.0.3 rename: was `costDeltaVsParentUSD`.)

## What's inside

- **Provider runners** — Claude, Codex, and any OpenAI-compatible endpoint
- **Routing engine** — capability filter → agent type → cheapest qualifier
- **`runTasks`** — parallel dispatch, returns per-task results with usage, cost, files touched, status, and escalation log
- **Reviewed lifecycle** — parallel spec + quality lint review by a different tier, conditional rework when verdicts demand changes, annotator-scored commit gate, file artifact verification
- **Executors** — pure `execute<Tool>(ctx, input)` functions for delegate, audit, review, debug, execute-plan, retry, investigate, research (used by the HTTP server package)
- **Tool schemas** — Zod-validated input shapes for each tool, exportable via `./tool-schemas/*`
- **BatchRegistry** — server-wide state machine for pending / awaiting_clarification / complete / failed / expired batches with context-block refcount pinning
- **Sandboxed tools** — `readFile`, `writeFile`, `grep`, `glob`, `listFiles`, `runShell` with `cwd-only` confinement

## v4 Engine API

The v4 release introduces a unified review surface and generic task executor, replacing the previous per-tool executor pattern.

### ReviewerEngine

Gating reviews for **artifact-producing** tools (`delegate`, `execute-plan`). Runs three review passes against worker output:

| Method | Review Type | Verdict |
|---|---|---|
| `runSpec(shell, input)` | Spec compliance review | `approved` \| `changes_required` |
| `runQualityAP(shell, input)` | Quality review (artifact-producing) | `approved` \| `changes_required` |
| `runDiff(shell, input)` | Diff review of written files | `approve` \| `concerns` \| `reject` |

Each method accepts a `RunnerShell` and a `ReviewerInput` (`{ workerOutput, brief, cwd, route?, fileContents?, toolCallLog?, filesWritten?, abortSignal?, deadlineMs? }`) and returns a typed result with parsed verdict, findings, and cost breakdown.

```ts
import { ReviewerEngine, ReviewerPromptBuilder } from '@zhixuan92/multi-model-agent-core/review';
import { specTemplate, qualityAPTemplate, diffTemplate } from '@zhixuan92/multi-model-agent-core/review';

const engine = new ReviewerEngine(
  new ReviewerPromptBuilder(
    { spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate },
    { /* per-route quality templates */ },
  ),
);

const result = await engine.runSpec(shell, {
  workerOutput: '...',
  brief: 'Add JWT auth to auth.ts',
  cwd: '/path/to/project',
});
// result.verdict → 'approved' | 'changes_required'
// result.findings → AnnotatedFinding[]
// result.cost → { inputTokens, outputTokens, turnCount, toolCallCount, costUSD }
```

Factory shortcut for the default template set:

```ts
import { createDefaultReviewerEngine } from '@zhixuan92/multi-model-agent-core/review/default-engines';
const engine = createDefaultReviewerEngine();
```

### AnnotatorEngine

Read-only annotation pass for **non-artifact-producing** tools (`audit`, `review`, `debug`, `investigate`, `research`, `explore`). Verdict is always `'annotated'` (success) or `'error'` (transport failure); never gates rework.

| Method | Description |
|---|---|
| `annotate(session, input)` | Runs an annotation pass, re-judging severity and scoring confidence per finding |

Accepts a `Session` (opened via the v4.4 provider boundary) and an `AnnotatorInput` (`{ workerOutput, brief, cwd, route, abortSignal?, deadlineMs? }`). Returns `AnnotatorCallResult` with parsed findings, raw assistant text, and cost breakdown.

```ts
import { AnnotatorEngine } from '@zhixuan92/multi-model-agent-core/review';

const engine = new AnnotatorEngine();
const result = await engine.annotate(shell, {
  workerOutput: '...',
  brief: 'Audit security of auth module',
  cwd: '/path/to/project',
  route: 'audit',
});
// result.findings → AnnotatedFinding[]
// result.finalAssistantText → string
```

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
  reviewTemplates?: {                                        // optional per-route review templates
    spec?: ReviewTemplate;
    qualityAP?: ReviewTemplate;
    annotator?: ReviewTemplate;
    diff?: ReviewTemplate;
  };
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
| `./intake/compilers/*` | Route compilers: `delegate`, `review`, `debug`, `audit`, `execute-plan`, `investigate`, `research` |
| `./reporting/parse-investigation-report` | `parseInvestigationReport`, `parseCitations`, `parseConfidence` (3.4.0) |
| `./auto-commit` | `autoCommitFiles` — git commit helper for worker file changes |
| `./file-artifact-check` | `partitionFilePaths`, `checkOutputTargets` — output target verification |
| `./telemetry/types` | `TelemetryEvent`, `UploadBatch`, `InstallMetadata` Zod schemas + `SCHEMA_VERSION` |
| `./telemetry/event-builder` | `buildTaskCompletedEvent`, `buildSessionStartedEvent`, etc. — pure event constructors |
| `./telemetry/consent-rules` | `decideConsent` — env / config / default precedence resolver |
| `./review` | `ReviewerEngine`, `AnnotatorEngine` — v4 review surface (see Engine API below) |
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

## What's new in 4.7.0

- **BREAKING: USD cost caps removed across the entire surface.** `defaults.maxCostUSD`, `tasks[].maxCostUSD`, `TaskSpec.maxCostUSD`, `RunOptions.maxCostUSD`, `DEFAULT_MAX_COST_USD`, `MAX_COST_PRESTOP_RATIO`, `pricingSchema`, `CostCheckEvent`, `'cost_exceeded'` terminal status, `'cost_cap'` incomplete reason — all deleted. Reported cost (`actualCostUSD`, `costUSD`) is unchanged; only the *cap* is gone. Migration: drop `maxCostUSD` everywhere.
- **Polling headline now reflects live stage + counts.** The server's `recordHeartbeat` callback writes a structured per-task snapshot (`stageLabel`, `stageDone`, `stageTotal`, `toolReads`/`toolWrites`/`toolTotal`). `/batch/:id` 202 responses advance through `Implementing → Review → Annotating → Committing` instead of staying frozen on the seed value.
- **`outputTargets` contract.** `/delegate` and `/execute-plan` tasks accept an optional `outputTargets: string[]`; missing paths post-run produce a `severity: high` finding (`missing_output_targets`).
- **Module removal:** `packages/core/src/escalation/` deleted entirely. Write routes now go through `ctx.getSession(tier)` directly. Also deleted: `RunningHeadlineSink`, `cleanup/` folder, `body-size.ts` middleware, dormant bounded-execution helpers (`IdleGuard`, `CostMeter`, etc.), and `config/pricing-table.ts`.
- **From 4.6.0, still relevant:** `isLlmStage` flag + `StageModelMissingError` defensive build, tier-uniformity invariant in `rollupByTier`, full token attribution on `RunAnnotatorResult` / `RunReviewerResult`, cross-tier reviewer policy via `invertedReviewerTier()`.

Full history: [CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md).

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
