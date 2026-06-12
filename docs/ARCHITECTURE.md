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
  1.1  Transport          server/src/http/{server,router}.ts
  1.2  Authentication     server/src/http/auth.ts
  1.3  Validation         server/src/http/{cwd-validator,canonicalize-file-paths}.ts
  1.4  Unified handler    server/src/http/handlers/unified-task.ts
                          (POST /task + GET /task/:taskId)

Stage 2 — INPUT VALIDATION  (validate + route request via type discriminator)
  2.1  Zod validation      core/src/unified/task-input-schema.ts (discriminated union)
  2.2  Type registry       core/src/unified/type-registry.ts (TYPE_REGISTRY → defaults, sandbox, worktree)
  2.3  Skill loading       core/src/unified/skill-loader.ts (implement.md + review.md per type)

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
  5.5  Persistence        core/src/unified/task-registry.ts,
                          core/src/stores/{batch-cache,context-block-tool}.ts,
                          run-tasks/commit-stage.ts, auto-commit.ts
```

Stages 3+4+5 are gated by each task's `reviewPolicy` (`reviewed | none`). Read-only types set `none`; artifact-producing types keep `reviewed`. The lifecycle inspects the policy and skips stages accordingly — there is no parallel "lite" lifecycle.

## Vertical axis — the type stack

Every task type is a stack of files at fixed layers. Adding a type adds one row at each layer; the layer itself never changes shape.

```
Layer L.1  Type registry    core/src/unified/type-registry.ts           (TASK_TYPES + TYPE_REGISTRY)
Layer L.2  Zod schema       core/src/unified/task-input-schema.ts       (discriminated union per type)
Layer L.3  Skill prompts    core/src/skills/<type>/implement.md + review.md  (worker criteria)
Layer L.4  Pipeline         core/src/unified/two-phase-pipeline.ts      (unified two-phase lifecycle)
Layer L.5  Bespoke output   core/src/reporting/parse-<type>-report.ts +
                            compose-<type>-headline.ts                   (types w/ custom output)
Layer L.6  Skill markdown   server/src/skills/mma-<type>/SKILL.md        (caller-facing prompt)
Layer L.7  Installer hook   server/src/install/{claude-code,cursor,codex-cli,
                            gemini-cli}.ts via manifest.ts                (per-client writer)
Layer L.8  Contract goldens tests/contract/goldens/endpoints/<type>-<stage>.json +
                            routes.json + observability.json
```

Per-type fill of the stack:

| Type | Review policy | Worktree | Sandbox | Skill |
|---|---|---|---|---|
| `delegate` | reviewed | yes | cwd-only | mma-delegate |
| `audit` | none | no | read-only | mma-audit |
| `review` | none | no | read-only | mma-review |
| `debug` | none | no | read-only | mma-debug |
| `execute_plan` | reviewed | yes | cwd-only | mma-execute-plan |
| `investigate` | none | no | read-only | mma-investigate |
| `research` | none | no | read-only | mma-research |
| `journal_recall` | none | no | read-only | mma-journal-recall |
| `journal_record` | none | no | cwd-only | mma-journal-record |
| `retry_tasks` | reviewed | no | cwd-only | mma-retry |

Two invariants the layered stack enforces:

- **Vertical layers don't reach across.** A schema (L.2) never imports bespoke output (L.5); a skill markdown (L.6) is plain prose with no code dependency. New types fill the stack top-to-bottom — they don't sneak in mid-stack.
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
C.6  State stores (in-process)   core/src/unified/task-registry.ts,
                                core/src/stores/{batch-cache,context-block-tool,
                                project-context-registry}.ts
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

1. **Ingress** — `server/src/http/server.ts` routes `POST /task?cwd=<abs>` to the unified handler (`handlers/unified-task.ts`). The handler validates the `type` discriminator via the Zod discriminated union in `unified/task-input-schema.ts`, reserves a `ProjectContext` per cwd, and registers a `TaskRegistry` entry.
2. **Pipeline** — The unified two-phase pipeline (`unified/two-phase-pipeline.ts`) loads skill prompts from `skills/<type>/implement.md` + `review.md` via `unified/skill-loader.ts`, resolves agent tier from `TYPE_REGISTRY`, and drives the implement + review lifecycle.
3. **Dispatch** — The pipeline picks a provider via the type's default tier, invokes `Provider.run(prompt, options)`, and supervises execution with bounded-execution guards.
4. **Review** — When `reviewPolicy` is `reviewed`, the pipeline runs a second-phase review pass. When `none`, the review phase is skipped.
5. **Reporting** — Results are aggregated into the uniform envelope, telemetry events emitted via the observability bus, and the result stored in `TaskRegistry` for retrieval via `GET /task/:taskId`.

**Same-repo dispatch serialization:** Write types (`delegate`, `execute_plan`) with `worktree: true` in `TYPE_REGISTRY` isolate their work in git worktrees. Tasks that share a git toplevel run in their own worktree; tasks in different repos run in parallel. This eliminates commit-stage and implement-stage races within a single repo. Read-only types (`audit`, `review`, `debug`, `investigate`, `research`) keep full `Promise.all` fan-out.

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
| `reviewPolicy` values `'spec_only'` / `'off'` / `'full'` / `'quality_only'` / `'diff_only'` | Removed. Closed enum is `'reviewed' | 'none'` |

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

- **A new provider:** `core/src/providers/<name>-runner.ts` with a `RunnerAdapter` implementation. Update provider factory.
- **A new task type:** Add to `TASK_TYPES` + `TYPE_REGISTRY` in `core/src/unified/type-registry.ts`. Add Zod schema variant in `core/src/unified/task-input-schema.ts`. Add skill prompts at `core/src/skills/<name>/implement.md` + `review.md`. Optional: `reporting/parse-<name>-report.ts` + `compose-<name>-headline.ts` if the output shape is bespoke. Add `server/skills/mma-<name>/SKILL.md` for the caller-facing prompt.
- **A new contract test:** `tests/contract/<area>/<topic>.test.ts`; goldens under `tests/contract/goldens/<area>/<topic>.json`. Capture via the `it.todo` → external capture script → flip pattern (never fail-first-then-copy).
- **A new observability event:** emit structured log line from a handler; add required fields to `tests/contract/goldens/observability.json`; the replay test picks it up automatically.

## Further reading

- `.claude/CLAUDE.md` — local conventions for contributors.
- `docs/refactor/types-inventory.md` — type relocation decisions (post-Ch 3).
- `docs/refactor/execution-context-inventory.md` — ExecutionContext field audit.
- `docs/refactor/runner-adapter-matrix.md` — per-provider viability analysis for the runner adapter.
- `docs/refactor/loc-baseline.md` — LOC baseline for the refactor.
- `DIRECTION.md` — product north star.

## Known limitations

### Git worktrees + a shared daemon

`mmagent serve` writes worker output relative to the dispatched `?cwd=`. Pairing a
**git worktree** with a daemon started from a *different* worktree is not currently
guaranteed to isolate filesystem writes on every platform (observed escaping to the
daemon's startup cwd under some Bun/Windows configurations). Until the root cause is
fixed, prefer one of:

- run the daemon from the directory you intend workers to write to, or
- do the work on a branch in a single worktree.

A write that escapes the dispatched cwd is **not silently accepted** — the task seals
`failed` with `tool_sandbox_cwd_violation` (see `recordTaskCompletedHandler`).
