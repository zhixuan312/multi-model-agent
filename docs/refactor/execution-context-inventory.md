# ExecutionContext Inventory (Ch 3 reviewer-gate artifact)

Definition: `packages/core/src/executors/types.ts:26-58`.
Builder: `packages/server/src/http/execution-context.ts:18-100` (the
only production call site constructing one).

This table records which fields are load-bearing and which are dead.
Drives the Task 22 redesign.

## Field audit

| Field | Type | Used by executor? | Destructured? | Serialized to report/log? | In schema? | Runtime reachable? | Decision |
|---|---|---|---|---|---|---|---|
| `projectContext` | `ProjectContext` | YES — all executors: `ctx.projectContext.cwd`, `projectContext.batchCache`, `projectContext.clarifications`, `projectContext.contextBlocks` | YES (retry, delegate) | no | no | yes | **KEEP** |
| `config` | `MultiModelConfig` | YES — every executor: `const { config } = ctx`, passed to runTasks | YES | no | no | yes | **KEEP** |
| `logger` | `DiagnosticLogger` | YES — passed to runTasks via `logger: ctx.logger` in every executor (verify, debug, review, execute-plan, retry) | no | emits events | no | yes | **KEEP** — usage inverted from the NOTE comment; executors DO pass it through. The comment claim ("not currently consumed by any executor") is now stale. |
| `contextBlockStore` | `ContextBlockStore` | YES — every executor: `const { contextBlockStore } = ctx`, passed to runTasks runtime | YES | no | no | yes | **KEEP** |
| `providerFactory` | `(profile: string) => Provider` | **NO** — zero consumers in core/server/tests | no | no | no | **no** | **DELETE** — confirmed dead. Nothing calls `ctx.providerFactory()`. Runners construct providers from config via `createProvider`. Its declared purpose ("future per-request provider overrides") is entirely speculative per the plan's "don't design for hypothetical future requirements" rule. |
| `onProgress` | `(event: ProgressEvent) => void` (optional) | **NO** — zero consumers. The `ProgressEvent` that flows through run-tasks is the *runner-local* one (types.ts:497), NOT this declaration here. Two different `ProgressEvent` types share a name. | no | no | no | no | **DELETE** — dead. Also resolves the `ProgressEvent` name collision. |
| `awaitClarification` | `(proposal: ClarificationProposal) => Promise<ClarificationResponse>` | **NO** — zero consumers. Intake's clarification is handled by the `ClarificationStore` on `projectContext`, not this callback. | no | no | no | no | **DELETE** — dead. Comment already admits "Not supported in MCP context (stub rejects)". |
| `parentModel` | `string?` | YES — every executor: `const parentModel = ctx.parentModel ?? config.defaults?.parentModel` | yes (via `??`) | yes (returned in `ExecutorOutput.parentModel`) | no | yes | **KEEP** |
| `batchId` | `string?` | YES — every executor: `...(ctx.batchId !== undefined && { batchId: ctx.batchId })` spread into runTasks options | yes | yes | no | yes | **KEEP** |
| `recordHeartbeat` | `(tick: HeartbeatTickInfo) => void` (optional) | YES — every executor: spread into runTasks options | yes | no | no | yes | **KEEP** |

## Dead fields summary

Three fields are safe to delete (all columns negative, not serialized):

1. `providerFactory` — redundant with config-based provider creation inside run-tasks.
2. `onProgress` — redundant with `recordHeartbeat`; never called.
3. `awaitClarification` — redundant with `projectContext.clarifications`; never called.

Deleting them removes 24 LOC from `executors/types.ts` and 10 LOC of dead-field wiring from `packages/server/src/http/execution-context.ts`.

## Auxiliary types in this file

- `ClarificationProposal` — *only* referenced by the `awaitClarification` field above. Delete-candidate if `awaitClarification` deletes.
- `ClarificationResponse` — same; delete with `awaitClarification`.
- `ProgressEvent` — shadow of runners/types.ts variant; never used outside the `onProgress` field declaration. Delete with `onProgress`.

## Recommended shape

Single flat `ExecutionContext` interface, 7 fields. NO split into `CoreExecutionContext` + per-executor extensions — every executor already consumes the same narrow surface (`config`, `contextBlockStore`, `projectContext`, `parentModel`, `batchId`, `recordHeartbeat`, `logger`). A split would add cognitive overhead with zero payoff.

Factory signature:

```ts
export interface ExecutionContextInput {
  projectContext: ProjectContext;
  config: MultiModelConfig;
  logger: DiagnosticLogger;
  contextBlockStore: ContextBlockStore;
  parentModel?: string;
  batchId?: string;
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
}

export function buildExecutionContext(input: ExecutionContextInput): ExecutionContext {
  if (!input.projectContext) throw new Error('buildExecutionContext: projectContext required');
  if (!input.config) throw new Error('buildExecutionContext: config required');
  if (!input.logger) throw new Error('buildExecutionContext: logger required');
  if (!input.contextBlockStore) throw new Error('buildExecutionContext: contextBlockStore required');
  return {
    projectContext: input.projectContext,
    config: input.config,
    logger: input.logger,
    contextBlockStore: input.contextBlockStore,
    ...(input.parentModel !== undefined && { parentModel: input.parentModel }),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.recordHeartbeat !== undefined && { recordHeartbeat: input.recordHeartbeat }),
  };
}
```

## Task 22 migration order

1. Delete `providerFactory`, `onProgress`, `awaitClarification` from the
   interface + builder.
2. Delete the three auxiliary types (`ClarificationProposal`,
   `ClarificationResponse`, `ProgressEvent` in executors/types.ts).
3. Introduce `buildExecutionContext` factory.
4. Replace the inline object literal at
   `packages/server/src/http/execution-context.ts:65-77` with the factory
   call.
5. Build + test.
