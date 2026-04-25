# types.ts Inventory (Ch 3 reviewer-gate artifact)

`packages/core/src/types.ts` is 654 LOC. Chapter 3 shrinks it to ≤150 LOC
by moving each export to its appropriate module. This table drives the
relocation.

**Consumer counts** are `grep -rn` matches across
`packages/core/src packages/server/src tests` (excluding `dist/`).

**Classifications:**

- `cross-cutting` — keep in `types.ts` (used across ≥3 modules).
- `runner-local` → `runners/types.ts`.
- `intake-local` → `intake/types.ts` (merge into existing file).
- `review-local` → `review/types.ts`.
- `routing-local` → `routing/types.ts`.
- `executor-local` → `executors/types.ts` (already exists).
- `dead` — delete.

## Inventory

| Symbol | Line | Classification | Consumers (primary) | Target location |
|---|---|---|---|---|
| `ToolMode` | 6 | cross-cutting | runners, tools, config, executors | keep in types.ts |
| `SandboxPolicy` | 7 | cross-cutting | runners, tools, config, handlers | keep in types.ts |
| `AgentType` | 11 | cross-cutting | config, routing, intake, executors | keep in types.ts |
| `AgentCapability` | 12 | cross-cutting | config, routing | keep in types.ts |
| `AgentConfig` | 14 | cross-cutting | config, routing | keep in types.ts |
| `Effort` | 28 | cross-cutting | config, runners, executors | keep in types.ts |
| `CostTier` | 29 | cross-cutting | config, routing | keep in types.ts |
| `RunStatus` | 30 | runner-local | runners, delegate-with-escalation, reporting (19 refs) | `runners/types.ts` |
| `FormatConstraints` | 43 | cross-cutting | TaskSpec consumers | keep in types.ts (co-located with TaskSpec) |
| `TaskSpec` | 48 | cross-cutting | intake, executors, runners, handlers (105 refs) | keep in types.ts |
| `CodexProviderConfig` | 93 | cross-cutting | config, runners | keep in types.ts |
| `ClaudeProviderConfig` | 111 | cross-cutting | config, runners | keep in types.ts |
| `OpenAICompatibleProviderConfig` | 128 | cross-cutting | config, runners | keep in types.ts |
| `ProviderConfig` | 151 | cross-cutting | runners, provider factory, config | keep in types.ts |
| `MultiModelConfig` | 158 | cross-cutting | config, handlers, executors (90 refs) | keep in types.ts |
| `TokenUsage` | 208 | runner-local | only runners + RunResult | `runners/types.ts` |
| `TerminationReason` | 217 | runner-local | runners + delegate-with-escalation | `runners/types.ts` |
| `RunResult` | 229 | runner-local | runners, executors, reporting (113 refs) | `runners/types.ts` — but re-exported from `types.ts` since executors + handlers use it as a boundary type. Verdict: **cross-cutting** — keep in types.ts to avoid 113 import changes. |
| `BatchTimings` | 316 | executor-local | executors only | `executors/types.ts` |
| `BatchProgress` | 323 | executor-local | executors | `executors/types.ts` |
| `BatchAggregateCost` | 332 | executor-local | executors | `executors/types.ts` |
| `AttemptRecord` | 341 | runner-local | runners + delegate-with-escalation | `runners/types.ts` |
| `Provider` | 378 | cross-cutting | runners, provider factory, tests (68 refs) | keep in types.ts |
| `RunOptions` | 384 | runner-local | runners, provider factory | `runners/types.ts` |
| `RunTasksRuntime` | 444 | runner-local | run-tasks only (4 refs) | `runners/types.ts` |
| `InternalRunnerEvent` | 459 | runner-local | runners, delegate-with-escalation, tracker, run-tasks | `runners/types.ts` |
| `ProgressEvent` | 497 | runner-local | run-tasks, heartbeat, executors/types | `runners/types.ts` — executors re-import via runners/types. |
| `EligibilityFailureCheck` | 519 | routing-local | routing | `routing/types.ts` |
| `EligibilityFailure` | 528 | routing-local | routing | `routing/types.ts` |
| `ProviderEligibility` | 534 | routing-local | routing | `routing/types.ts` |
| `BriefQualityWarning` | 544 | intake/readiness-local | readiness, run-tasks | `intake/types.ts` |
| `BriefQualityPolicy` | 554 | intake-local | intake, config | `intake/types.ts` |
| `ReadinessResult` | 556 | intake/readiness-local | readiness | `intake/types.ts` |
| `computeCostUSD` | 573 | runner-local | cost-meter, runners (36 refs) | `cost/compute.ts` (new) or keep — it's a utility function. Verdict: keep in types.ts for now (function, not a type; moving churns 36 imports without payoff). |
| `computeSavedCostUSD` | 592 | runner-local | cost-meter, runners (35 refs) | same as above — keep. |
| `withTimeout` | 630 | cross-cutting utility | 8 refs | keep in types.ts. |

## Target types.ts shape after Ch 3

`types.ts` keeps these symbols only:

- `ToolMode`, `SandboxPolicy`, `AgentType`, `AgentCapability`, `AgentConfig`
- `Effort`, `CostTier`
- `FormatConstraints`, `TaskSpec`
- `CodexProviderConfig`, `ClaudeProviderConfig`, `OpenAICompatibleProviderConfig`, `ProviderConfig`
- `MultiModelConfig`
- `RunResult` (re-exported from runners/types.ts — see Task 19 for the
  one-line re-export pattern)
- `Provider`
- `computeCostUSD`, `computeSavedCostUSD`, `withTimeout`

Estimated LOC: ~130 (types + re-export). Under the 150 cap with ~20 LOC
headroom for doc comments.

## Dead exports: none

All 35 exports have at least one live consumer. No `dead` rows.

## Target files

| Target file | New symbols |
|---|---|
| `runners/types.ts` (new) | `RunStatus`, `TokenUsage`, `TerminationReason`, `AttemptRecord`, `RunOptions`, `RunTasksRuntime`, `InternalRunnerEvent`, `ProgressEvent` |
| `executors/types.ts` (add) | `BatchTimings`, `BatchProgress`, `BatchAggregateCost` |
| `intake/types.ts` (add) | `BriefQualityWarning`, `BriefQualityPolicy`, `ReadinessResult` |
| `routing/types.ts` (new) | `EligibilityFailureCheck`, `EligibilityFailure`, `ProviderEligibility` |
