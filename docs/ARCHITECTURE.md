# Architecture

One-page orientation for maintainers. Deeper content lives alongside code.

## The three axes

multi-model-agent is organized around three axes. A request is a *path* through them, not a region.

- **Horizontal** — request flow: a request descends through five stages from the HTTP boundary to the terminal envelope.
- **Vertical** — tool surface: each tool exists as a stack of files at fixed layers (schema → handler → compiler → executor → ...). Adding a tool means filling the stack top-to-bottom; the layers themselves never change shape.
- **Substrate** — orthogonal capabilities (auth, cost, telemetry, runners, research) every stage and every tool borrows from.

**Package rule of thumb:** `packages/core` has no knowledge of HTTP. `packages/server` has no LLM-calling logic — it hands off to core via `executors/*.ts`.

## Horizontal axis — the five stages

Each stage decomposes into sub-layers that always run in this order. The pipeline is one-way except for the rework sub-loop inside Stage 4.

```
Stage 1 — INGRESS  (HTTP boundary)
  1.1  Transport          server/src/http/{server,router,loopback}.ts
  1.2  Authentication     server/src/http/auth.ts
  1.3  Validation         server/src/http/{cwd-validator,canonicalize-file-paths}.ts
  1.4  Context binding    server/src/http/{project-registry,handler-deps,
                          request-pipeline,request-observability}.ts +
                          core/src/executors/execution-context.ts

Stage 2 — BRIEF COMPILATION  (interpret request → executable brief, per-tool)
  2.1  Per-tool briefSlot  core/src/tools/<tool>/tool-config.ts (briefSlot field)  ← vertical slice point
                           (PR 2 of intake-dissolution will extract to
                           core/src/tools/<tool>/brief-slot.ts uniformly)
  2.2  Boundary validation packages/server/src/http/validation/verify-command
                           (server-side gate before dispatch)

Stage 3 — DISPATCH  (pick agent, run implementer, supervise)
  3.1  Agent resolution   core/src/routing/{resolve-agent,model-profiles,
                          canonical-model-identity}.ts
  3.2  Lifecycle drive    core/src/run-tasks/{index,execute-task,
                          reviewed-lifecycle}.ts
  3.3  Escalation         core/src/delegate-with-escalation.ts +
                          core/src/escalation/{policy,fallback}.ts
  3.4  Provider invoke    core/src/runners/{claude,codex,openai}-runner.ts
                          via runners/base/*
  3.5  In-call control    core/src/runners/supervision.ts, tools/scratchpad.ts,
                          heartbeat.ts, cost/cost-meter.ts, file-artifact-check.ts,
                          run-tasks/stage-idle-tracker.ts
  3.6  Tools surface      core/src/tools/{definitions,claude-adapter,
                          openai-adapter,tracker,call-cache}.ts +
                          research substrate (see C.4)

Stage 4 — REVIEW  (cross-agent verdict + rework)
  4.1  Prompt build       core/src/lifecycle/handlers/{spec-review-prompt,quality-review-prompt}.ts
  4.2  Reviewer execution core/src/lifecycle/handlers/review-stage.ts
  4.3  Finding parsing    core/src/lifecycle/handlers/parse-review-report.ts
  4.4  Aggregation+rework core/src/lifecycle/handlers/{rework-stage,tier-policy}.ts

Stage 5 — REPORTING  (parse, derive, compose, persist, emit)
  5.1  Output parsing     core/src/reporting/{structured-report,
                          parse-investigation-report,parse-explore-report}.ts
  5.2  Status derivation  core/src/run-tasks/worker-status.ts +
                          reporting/{terminal-status-deriver,
                          derive-explore-status,derive-investigate-status}.ts
  5.3  Headline           core/src/reporting/compose-{terminal,running,explore,
                          investigate}-headline.ts, not-applicable.ts
  5.4  Telemetry emit     core/src/telemetry/{event-builder,normalize,clamp,
                          bucketing,field-coverage,concern-classifier,
                          consent-rules}.ts +
                          observability/{bus,events,*-sink}.ts
  5.5  Persistence        core/src/{batch-registry,batch-cache,async-dispatch}.ts,
                          context/context-block-store.ts,
                          run-tasks/commit-stage.ts, auto-commit.ts
```

Stages 3+4+5 are gated by each task's `reviewPolicy` (`full | quality_only | diff_only | none`). Read-only presets set `quality_only` or `none`; artifact-producing presets keep `full`. The lifecycle inspects the policy and skips stages accordingly — there is no parallel "lite" lifecycle.

## Vertical axis — the tool stack

Every tool is a stack of files at fixed layers. Adding a tool adds one row at each layer; the layer itself never changes shape.

```
Layer L.1  Schema           core/src/tool-schemas/<tool>.ts            (Zod input/output)
Layer L.2  HTTP handler     server/src/http/handlers/tools/<tool>.ts   (or .../control/)
Layer L.3  Brief slot       core/src/tools/<tool>/tool-config.ts:briefSlot  (raw → TaskBrief[])
Layer L.4  Executor         core/src/executors/<tool>.ts               (review policy + lifecycle)
Layer L.5  Bespoke output   core/src/reporting/parse-<tool>-report.ts +
                            compose-<tool>-headline.ts                  (tools w/ custom output)
Layer L.6  Skill markdown   server/src/skills/mma-<tool>/SKILL.md       (caller-facing prompt)
Layer L.7  Installer hook   server/src/install/{claude-code,cursor,codex-cli,
                            gemini-cli}.ts via manifest.ts               (per-client writer)
Layer L.8  Contract goldens tests/contract/goldens/endpoints/<tool>-<stage>.json +
                            routes.json + observability.json
```

Per-tool fill of the stack:

| Tool | L.4 executor | L.5 bespoke output | L.6 skill |
|---|---|---|---|
| `delegate_tasks` | full review | — | mma-delegate |
| `audit_document` | quality_only | — | mma-audit |
| `review_code` | quality_only | — | mma-review |
| `debug_task` | quality_only | — | mma-debug |
| `execute_plan` | full review + plan-extraction | — | mma-execute-plan |
| `investigate` | review off | parse-investigation-report + compose-investigate-headline | mma-investigate |
| `explore` | review off + research adapters | parse-explore-report + compose-explore-headline + derive-explore-status | mma-explore |
| `retry_tasks` | replay prior batch | — | mma-retry |
| `register_context_block` | state-only (no executor) | — | mma-context-blocks |
| `get_batch_slice` | state-only | — | (used internally by mma-* skills) |

Two invariants the layered stack enforces:

- **Vertical layers don't reach across.** A schema (L.1) never imports an executor (L.4); a skill markdown (L.6) is plain prose with no code dependency. New tools fill the stack top-to-bottom — they don't sneak in mid-stack.
- **Horizontal stages don't reach backwards.** Reporting (5) reads from Review (4) outputs; Review never reads from Reporting. The pipeline is one-way except for the rework sub-loop inside Stage 4.

## Substrate — orthogonal capabilities

These layers underlie every stage and every tool. They aren't on either axis; they're the floor both axes stand on.

```
C.1  Identity & sandboxing      core/src/auth/{claude,codex}-oauth.ts,
                                server/src/http/auth.ts,
                                cwd-validator.ts, loopback.ts
C.2  Bounded execution           core/src/cost/cost-meter.ts, heartbeat.ts,
                                escalation/{policy,fallback}.ts,
                                file-artifact-check.ts, error-codes.ts
C.3  Provider abstraction        core/src/provider.ts,
                                runners/base/{types,result-builders,research-tools,
                                time-check,usage-accumulator}.ts,
                                runners/{supervision,error-classification,
                                injection-type,prevention}.ts, model-profiles.json
C.4  Research substrate          core/src/research/{allowlist,ssrf-guard,web-fetch,
                                web-search,untrusted-content}.ts +
                                research/adapters/{arxiv,github-search,
                                semantic-scholar,generic-rss}.ts
C.5  Telemetry & observability   core/src/telemetry/{event-builder,normalize,clamp,
                                bucketing,field-coverage,concern-classifier,
                                consent-rules}.ts,
                                observability/{bus,events,buckets,*-sink}.ts,
                                diagnostics/{jsonl-writer,http-server-log,
                                request-spill,verbose-line}.ts
C.6  State stores (in-process)   core/src/{project-context,batch-registry,
                                batch-cache}.ts, context/context-block-store.ts
C.7  Distribution                server/src/install/{claude-code,cursor,codex-cli,
                                gemini-cli,discover,manifest,manifest-resolve,
                                missing-skills,orchestrate,headers,notify,
                                include-utils}.ts +
                                server/src/skills/mma-*/SKILL.md
```

A single request reads as a path: the horizontal axis tells you *which stage*, the vertical axis tells you *which file does that stage's work for this tool*, and the substrate tells you *which capability the stage borrows from*.

## Runner adapter taxonomy

Each provider runner calls into a `RunnerAdapter<ProviderTurn, ProviderUsage>` implementation (see `core/src/runners/base/types.ts`). The adapter normalizes turn observations (text, usage, tool calls, finish reason) so the shared runner shell can own supervision, scratchpad salvage, watchdog policy, cost ceilings, and result building via `runners/base/result-builders.ts`. Provider-specific I/O (OpenAI Agents SDK, Anthropic Claude SDK, OpenAI Responses for Codex) stays inside each adapter.

## Request lifecycle (concrete trace)

1. **Ingress** — `server/src/http/server.ts` routes `POST /<tool>?cwd=<abs>` to a handler. Handlers reserve a `ProjectContext` per cwd and build an `ExecutionContext` via `core/src/executors/execution-context.ts`.
2. **Brief compilation** — Each route's `tools/<tool>/tool-config.ts:briefSlot` translates raw input into `Brief[]` consumed by the generic executor. No central pipeline; each tool owns its briefSlot (PR 2 of intake-dissolution extracts these into uniform `tools/<tool>/brief-slot.ts` files). Boundary validation (e.g. `validateVerifyCommand`) runs server-side before dispatch. v4.0 removed the clarification gate; ambiguous briefs proceed with the most likely interpretation.
3. **Dispatch** — `core/src/run-tasks/index.ts::runTasks` drives each task through `reviewed-lifecycle.ts`, which calls `execute-task.ts` → `delegate-with-escalation.ts`. The escalation orchestrator picks a provider via `routing/resolve-agent.ts` and invokes `Provider.run(prompt, options)`, collecting `AttemptRecord`s.
4. **Review** — `reviewed-lifecycle.ts` runs spec review, quality review, and (when applicable) diff review per the task's `reviewPolicy`, looping rework until approved, plateaued, or capped.
5. **Reporting** — Results are aggregated into the uniform 7-field envelope (`ExecutorOutput`), telemetry events emitted via the observability bus, and the result stored in `BatchRegistry` for retrieval via `GET /batch/:id`.

**Same-repo dispatch serialization (4.6.0+):** Write routes (`/delegate`, `/execute-plan`) opt into `serializeSameRepo` on their `ToolConfig`. Tasks that share a git toplevel (or raw cwd when not in a git repo) run sequentially in caller input order; tasks in different repos run in parallel across groups. This eliminates commit-stage and implement-stage races within a single repo. Read-only routes (`audit`, `review`, `debug`, `investigate`, `explore`) keep full `Promise.all` fan-out.

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
| `packages/core/src/types.ts` (654 LOC dumping ground) | Cross-cutting only (~147 LOC); runner-local types in `runners/types.ts`, brief-local types in each `tools/<tool>/brief-slot.ts`, routing-local in `routing/types.ts`, executor-local in `executors/types.ts` |
| `packages/mcp/` | Deleted. All MCP-layer concerns now live under `packages/server/` (HTTP service) + `packages/server/src/skills/` (distributed skill markdown) |
| `ExecutionContext.providerFactory`, `.onProgress`, `.awaitClarification` | Deleted — all three were dead fields. `ExecutionContext` now has 7 fields; construction goes through `executors/execution-context.ts::buildExecutionContext` |
| `buildXOkResult` / `buildXIncompleteResult` / `buildXForceSalvageResult` / `buildXMaxTurnsExitResult` duplicated across three runners | Shared builders in `runners/base/result-builders.ts`; runners pass pre-normalized usage. Adapter interface at `runners/base/types.ts` |
| Clarification flow (clarification-store, force-clarification, confirm route, `mma-clarifications` skill) | Deleted in v4.0. Routes ambiguous briefs by picking the most likely interpretation. `proposedInterpretation` is no longer in the response envelope |
| `readiness/readiness.ts`, `effort-inference.ts`, `cross-tier-guard.ts` | Removed. Effort flows from dispatch directly; per-tool briefSlot in `tools/<tool>/tool-config.ts` is the sole brief-construction layer |
| `core/src/intake/` directory (pipeline, classify, resolve, field-inferer, context-overflow-estimator, source-schema, verify-referenced-blocks, host-allowlist-builder, brief-compiler classes, dead scaffolded slots) | Removed across PR 1 + PR 2 of the intake-dissolution cleanup. Live brief compilation co-located with each tool at `tools/<tool>/brief-slot.ts`. Plan extraction + draft-id helpers under `tools/execute-plan/`. Boundary `verify-command` validator moved to `packages/server/src/http/validation/` |
| 5-field `TokenUsage` (`cachedCreationTokens`, `reasoningTokens`, …) | 4-field canonical shape: `{inputTokens, outputTokens, cachedReadTokens, cachedNonReadTokens}`. `outputTokens` includes reasoning. SCHEMA_VERSION bumped to 4 |
| `reviewPolicy` values `'spec_only'` / `'off'` | Removed. Closed enum is `'full' | 'quality_only' | 'diff_only' | 'none'` |

### v0.4.7.5 — Intake directory dissolved; per-route briefSlots co-located

The `packages/core/src/intake/` directory was removed. Every dispatching route now owns its briefSlot at `packages/core/src/tools/<route>/brief-slot.ts` with the uniform shape `<route>BriefSlot` + `<Route>Brief`.

**Removed public exports (TypeScript error on upgrade if consumed externally):**

- `runIntakePipeline`, `classifyDraft`, `inferMissingFields`, `resolveDraft`
- `validateSource`
- `compileExecutePlan`, `executePlanSlot`, `makeRetrySlot`
- `extractPlanSection`, `PlanExtractionError`, `PlanSection`
- `compileDelegatePrompt`
- `createDraftId`, `parseDraftId`, `generateRequestId`
- Intake route enums (`SourceRoute`, `AnySource`, `DelegateSource`, `IntakeResult`, etc.)

**Removed `./intake/*` subpath exports from `packages/core/package.json`** (a separate flavor of break for consumers importing via the subpath form):

- `./intake/pipeline`, `./intake/classify`, `./intake/resolve`, `./intake/field-inferer`, `./intake/source-schema`, `./intake/types`, `./intake/draft-id`, `./intake/verify-command-validator`
- `./intake/brief-compiler-slots/debug`, `./intake/brief-compiler-slots/delegate`, `./intake/brief-compiler-slots/execute-plan`, `./intake/brief-compiler-slots/research`, `./intake/brief-compiler-slots/review`

**Renamed:** `toolExecutePlanBriefSlot` → `executePlanBriefSlot` (drops the `tool` prefix that disambiguated from the deleted `executePlanSlot`).

**Re-routed (still exported under the same name from new home):**

- `BriefQualityPolicy` — now from `core/src/types/brief-quality-policy.ts`
- `DraftTask` — now from `core/src/types/draft-task.ts`
- `ReviewPolicy` — extracted to `core/src/types/review-policy.ts` (shared by delegate + execute-plan briefs)

**Server-side move:** `verify-command-validator.ts` moved from `core/src/intake/` to `packages/server/src/http/validation/verify-command.ts`. Internal to server package; no public-API impact.

Where to add:

- **A new provider:** `core/src/runners/<name>-runner.ts` with a `RunnerAdapter` implementation and a `runX(prompt, options, runnerOpts)` entry point. Update `core/src/provider.ts` factory.
- **A new specialized preset:** fill the L.1–L.7 stack — `tool-schemas/<name>.ts`, `tools/<name>/brief-slot.ts` (briefSlot extraction; PR 2 of intake-dissolution makes this the uniform pattern), `tools/<name>/tool-config.ts`, `server/http/handlers/tools/<name>.ts`, optional `reporting/parse-<name>-report.ts` + `compose-<name>-headline.ts` if the output shape is bespoke, and `server/skills/mma-<name>/SKILL.md`.
- **A new contract test:** `tests/contract/<area>/<topic>.test.ts`; goldens under `tests/contract/goldens/<area>/<topic>.json`. Capture via the `it.todo` → external capture script → flip pattern (never fail-first-then-copy).
- **A new observability event:** emit structured log line from `diagnostics/` or a handler; add required fields to `tests/contract/goldens/observability.json`; the replay test picks it up automatically.
- **A new tool/route:** register in `server/src/http/server.ts`; add handler under `http/handlers/tools/`; add route to `tests/contract/goldens/routes.json`; add tool schema in `core/src/tool-schemas/`; pin per-stage goldens under `tests/contract/goldens/endpoints/`.

## Further reading

- `.claude/CLAUDE.md` — local conventions for contributors.
- `docs/refactor/types-inventory.md` — type relocation decisions (post-Ch 3).
- `docs/refactor/execution-context-inventory.md` — ExecutionContext field audit.
- `docs/refactor/runner-adapter-matrix.md` — per-provider viability analysis for the runner adapter.
- `docs/refactor/loc-baseline.md` — LOC baseline for the refactor.
- `DIRECTION.md` — product north star.
