# Architecture

One-page orientation for maintainers. Deeper content lives alongside code.

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ packages/server — runtime surface (HTTP service + install CLI)       │
│   cli/            CLI entry (serve, print-token, install-skill)      │
│   http/           Router, middleware, tool + control handlers        │
│     handlers/tools/     delegate, audit, review, verify, debug,      │
│                         execute-plan, retry                          │
│     handlers/control/   batch polling, context-blocks, clarifications│
│   install/        Per-client writers (codex-cli, gemini-cli, cursor) │
│   skills/         Packaged mma-* skills (Markdown SKILL.md files)    │
│   openapi.ts      Schema generator for public contract               │
├──────────────────────────────────────────────────────────────────────┤
│ packages/core — library                                              │
│   config/         Config schema + loader (Zod)                       │
│   intake/         Brief compile, classify, clarify; compilers per    │
│                    route under compilers/                            │
│   readiness/      Brief-quality evaluation                           │
│   executors/      One file per tool (delegate/audit/review/verify/   │
│                    debug/execute-plan/retry); ExecutionContext       │
│                    factory                                           │
│   run-tasks/      Orchestrator — intake → dispatch → review → report │
│                    (index, execute-task, reviewed-lifecycle,         │
│                    worker-status, fallback-report, plan-extraction)  │
│   runners/        Per-provider runners (openai, claude, codex);      │
│                    shared interface + result-builders under base/    │
│   review/         Spec + quality reviewer prompts, aggregation       │
│   reporting/      Structured report parser, headline composers       │
│   routing/        Agent resolver + model profiles                    │
│   tools/          Tool definitions + provider adapters + tracker     │
│   cost/           Cost metering                                      │
│   context/        Context block store + expansion                    │
│   diagnostics/    JSONL event logger                                 │
│   types.ts        Cross-cutting types only (TaskSpec, Provider,      │
│                    RunResult, ProviderConfig, MultiModelConfig)      │
└──────────────────────────────────────────────────────────────────────┘
```

**Rule of thumb:** `packages/core` has no knowledge of HTTP. `packages/server` has no LLM-calling logic — it hands off to core via `executors/*.ts`.

## Runner adapter taxonomy

Each provider runner calls into a `RunnerAdapter<ProviderTurn, ProviderUsage>` implementation (see `packages/core/src/runners/base/types.ts`). The adapter normalizes turn observations (text, usage, tool calls, finish reason) so the shared runner shell can own supervision, scratchpad salvage, watchdog policy, cost ceilings, and result building via `runners/base/result-builders.ts`. Provider-specific I/O (OpenAI Agents SDK, Anthropic Claude SDK, OpenAI Responses for Codex) stays inside each adapter.

## Request lifecycle

1. **Ingress** — `packages/server/src/http/server.ts` routes `POST /<tool>?cwd=<abs>` to a handler. Handlers reserve a `ProjectContext` per cwd and build an `ExecutionContext` via `core/src/executors/execution-context.ts`.
2. **Intake** — `core/src/intake/*.ts` compiles raw input into `DraftTask[]`, classifies brief quality, and decides whether to emit a clarification proposal. Route compilers live under `intake/compilers/`.
3. **Dispatch** — `core/src/run-tasks/index.ts::runTasks` drives each task through `reviewed-lifecycle.ts`, which orchestrates implementer → spec review → quality review → (optional) rework.
4. **Execution** — `reviewed-lifecycle` calls `execute-task.ts` which delegates to `delegate-with-escalation.ts`. The escalation orchestrator picks a provider via `routing/resolve-agent.ts`, calls the provider's `Provider.run(prompt, options)`, and collects `AttemptRecord`s.
5. **Reporting** — Results are aggregated into the uniform 7-field envelope (`ExecutorOutput`), stored in `BatchRegistry`, and returned via `GET /batch/:id`.

## Testing layers

| Layer | Location | Purpose |
|---|---|---|
| Unit | `tests/<module>/*.test.ts` | Per-file behavior |
| Integration | `tests/delegate*.test.ts`, `tests/reviewed-execution/*.test.ts` | Mock-provider runs through run-tasks |
| Contract | `tests/contract/**` | HTTP envelopes + skill manifest + observability + route enumeration; goldens under `tests/contract/goldens/` |
| Perf | `tests/perf/*.test.ts` | Baseline + budget enforcement |

Mock-provider pattern: `mockProvider` / `failProvider` from `tests/delegate.test.ts` and `tests/contract/fixtures/mock-providers.ts`. Never call real LLM APIs in tests.

## Key observables

- Route manifest: `tests/contract/goldens/routes.json` (canonical list of HTTP routes; change breaks the manifest test).
- Observability manifest: `tests/contract/goldens/observability.json` (required event + field set a replayed scenario must emit).
- Per-endpoint + per-lifecycle-stage goldens: `tests/contract/goldens/endpoints/<tool>-<stage>.json`.
- LOC baseline: `docs/refactor/loc-baseline.md` (branch-cut snapshot for reduction proofs).

## Maintainer migration appendix

Old path → new path map (for readers coming from pre-3.2.0):

| Old | New |
|---|---|
| `packages/core/src/run-tasks.ts` (monolith) | `packages/core/src/run-tasks/index.ts` + siblings (`execute-task`, `reviewed-lifecycle`, `worker-status`, `fallback-report`, `plan-extraction`) |
| `packages/core/src/types.ts` (654 LOC dumping ground) | Cross-cutting only (~147 LOC); runner-local types in `runners/types.ts`, intake-local in `intake/types.ts`, routing-local in `routing/types.ts`, executor-local in `executors/types.ts` |
| `packages/mcp/` | Deleted. All MCP-layer concerns now live under `packages/server/` (HTTP service) + `packages/server/src/skills/` (distributed skill markdown) |
| `ExecutionContext.providerFactory`, `.onProgress`, `.awaitClarification` | Deleted — all three were dead fields. `ExecutionContext` now has 7 fields; construction goes through `executors/execution-context.ts::buildExecutionContext` |
| `buildXOkResult` / `buildXIncompleteResult` / `buildXForceSalvageResult` / `buildXMaxTurnsExitResult` duplicated across three runners | Shared builders in `runners/base/result-builders.ts`; runners pass pre-normalized usage. Adapter interface at `runners/base/types.ts` |

Where to add:

- **A new provider:** `packages/core/src/runners/<name>-runner.ts` with a `RunnerAdapter` implementation and a `runX(prompt, options, runnerOpts)` entry point. Update `packages/core/src/provider.ts` factory.
- **A new specialized preset (audit variant, custom review):** `packages/core/src/executors/<name>.ts` + `packages/core/src/intake/compilers/<name>.ts` + `packages/server/src/http/handlers/tools/<name>.ts` + (optionally) a `packages/server/src/skills/mma-<name>/SKILL.md`.
- **A new contract test:** `tests/contract/<area>/<topic>.test.ts`; goldens under `tests/contract/goldens/<area>/<topic>.json`. Capture via the `it.todo` → external capture script → flip pattern (never fail-first-then-copy).
- **A new observability event:** emit structured log line from `diagnostics/` or a handler; add required fields to `tests/contract/goldens/observability.json`; the replay test picks it up automatically.
- **A new tool/route:** register in `packages/server/src/http/server.ts`; add handler under `http/handlers/tools/`; add route to `tests/contract/goldens/routes.json`; add tool schema in `core/src/tool-schemas/`; pin per-stage goldens under `tests/contract/goldens/endpoints/`.

## Further reading

- `.claude/CLAUDE.md` — local conventions for contributors.
- `docs/refactor/types-inventory.md` — type relocation decisions (post-Ch 3).
- `docs/refactor/execution-context-inventory.md` — ExecutionContext field audit.
- `docs/refactor/runner-adapter-matrix.md` — per-provider viability analysis for the runner adapter.
- `docs/refactor/loc-baseline.md` — LOC baseline for the refactor.
- `DIRECTION.md` — product north star.
