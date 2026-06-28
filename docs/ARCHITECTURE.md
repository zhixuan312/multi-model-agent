# Architecture

One-page orientation for maintainers. Deeper content lives alongside code.

## The three axes

multi-model-agent is organized around three axes. A request is a *path* through them, not a region.

- **Horizontal** — request flow: a request descends through five stages from the HTTP boundary to the terminal envelope.
- **Vertical** — tool surface: each task type exists as a stack of files at fixed layers (registry → schema → skill → pipeline → ...). Adding a type means filling the stack top-to-bottom; the layers themselves never change shape.
- **Substrate** — orthogonal capabilities (auth, cost, telemetry, runners, research) every stage and every type borrows from.

**Package rule of thumb:** `packages/core` has no knowledge of HTTP. `packages/server` has no LLM-calling logic — it hands off to core via the unified two-phase pipeline.

## Horizontal axis — the five stages

Each stage decomposes into sub-layers that always run in this order. The pipeline is one-way.

```
Stage 1 — INGRESS  (HTTP boundary)
  1.1  Transport          server/src/http/server.ts
  1.2  Authentication     server/src/http/auth.ts
  1.3  Validation         server/src/http/cwd-validator.ts
  1.4  Unified handler    server/src/http/handlers/unified-task.ts
                          (POST /task + GET /task/:taskId)

Stage 2 — INPUT VALIDATION  (validate + route request via type discriminator)
  2.1  Zod validation      core/src/unified/task-input-schema.ts (discriminated union)
  2.2  Type registry       core/src/unified/type-registry.ts (TYPE_REGISTRY → defaults, sandbox, worktree)
  2.3  Skill loading       core/src/unified/skill-loader.ts (implement.md + review.md per type)

Stage 3 — DISPATCH  (pick agent, run implementer)
  3.1  Agent resolution   core/src/providers/agent-resolver.ts +
                          core/src/config/model-profile-registry.ts
  3.2  Two-phase pipeline core/src/unified/two-phase-pipeline.ts
  3.3  Provider invoke    core/src/providers/{claude,codex}.ts
                          via providers/provider-factory.ts
  3.4  Bounded execution  core/src/bounded-execution/{activity-tracker,cost-compute}.ts
                          (provider-level wallClockDeadline + abortSignal)

Stage 4 — REVIEW  (cross-agent verdict via two-phase pipeline)
  4.1  Reviewer execution core/src/unified/two-phase-pipeline.ts (second phase)
  4.2  Finding parsing    core/src/unified/reviewer-output-parser.ts
  (When reviewPolicy is 'none', the review phase is skipped entirely.)

Stage 5 — REPORTING  (parse, derive, compose, persist, emit)
  5.1  Output parsing     core/src/reporting/structured-report.ts
  5.2  Status derivation  core/src/reporting/terminal-status-deriver.ts
  5.3  Sentinels          core/src/reporting/not-applicable.ts
  5.4  Telemetry emit     core/src/events/{envelope-bus,task-envelope,wire-schema,
                          to-wire-record,consent-rules,telemetry-uploader}.ts
  5.5  Persistence        core/src/unified/task-registry.ts,
                          core/src/stores/{context-block-tool,
                          project-context-registry}.ts
```

Stages 3+4+5 are gated by each task's `reviewPolicy` (`reviewed | none`). All types default to `reviewed` (except `orchestrate` which forces `none`). The two-phase pipeline inspects the policy and skips the review phase accordingly. Callers can override to `none` per-request for any type.

## Vertical axis — the type stack

Every task type is a stack of files at fixed layers. Adding a type adds one row at each layer; the layer itself never changes shape.

```
Layer L.1  Type registry    core/src/unified/type-registry.ts           (TASK_TYPES + TYPE_REGISTRY)
Layer L.2  Zod schema       core/src/unified/task-input-schema.ts       (discriminated union per type)
Layer L.3  Skill prompts    core/src/skills/<type>/implement.md + review.md  (worker criteria)
Layer L.4  Pipeline         core/src/unified/two-phase-pipeline.ts      (unified two-phase pipeline)
Layer L.5  Refiner schema   core/src/unified/refiner-schemas.ts          (per-type output Zod validation)
Layer L.6  Skill markdown   server/src/skills/mma-<type>/SKILL.md        (caller-facing prompt)
Layer L.7  Installer hook   server/src/skill-install/skill-installers/{claude-code,
                            cursor,codex-cli,gemini-cli}.ts via manifest.ts  (per-client writer)
Layer L.8  Contract goldens tests/contract/goldens/endpoints/<type>-<stage>.json +
                            routes.json + observability/event-manifest.json
```

Per-type fill of the stack:

| Type | Review policy | Worktree | Sandbox | Skill |
|---|---|---|---|---|
| `delegate` | reviewed | yes | cwd-only | mma-delegate |
| `audit` | reviewed | no | read-only | mma-audit |
| `review` | reviewed | no | read-only | mma-review |
| `debug` | reviewed | no | read-only | mma-debug |
| `execute_plan` | reviewed | yes | cwd-only | mma-execute-plan |
| `investigate` | reviewed | no | read-only | mma-investigate |
| `research` | reviewed | no | read-only | mma-research |
| `journal_recall` | reviewed | no | read-only | mma-journal-recall |
| `journal_record` | reviewed | no | cwd-only | mma-journal-record |
| `retry_tasks` | reviewed | no | cwd-only | mma-retry |
| `orchestrate` | none | no | cwd-only | mma-orchestrate |

Two invariants the layered stack enforces:

- **Vertical layers don't reach across.** A schema (L.2) never imports bespoke output (L.5); a skill markdown (L.6) is plain prose with no code dependency. New types fill the stack top-to-bottom — they don't sneak in mid-stack.
- **Horizontal stages don't reach backwards.** Reporting (5) reads from Review (4) outputs; Review never reads from Reporting. The pipeline is one-way except for the rework sub-loop inside Stage 4.

## Substrate — orthogonal capabilities

These layers underlie every stage and every tool. They aren't on either axis; they're the floor both axes stand on.

```
C.1  Identity & sandboxing      core/src/identity/{claude-oauth,secret-redactor}.ts,
                                server/src/http/auth.ts,
                                server/src/http/cwd-validator.ts,
                                core/src/transport/loopback-enforcer.ts,
                                core/src/providers/claude-cwd-confinement.ts
                                (PreToolUse hook: cwd-only + read-only enforcement)
C.2  Bounded execution           core/src/bounded-execution/{activity-tracker,
                                cost-compute}.ts,
                                core/src/error-codes.ts
                                (provider-level wallClockDeadline + abortSignal)
C.3  Provider abstraction        core/src/providers/provider-factory.ts,
                                providers/{claude,codex}.ts,
                                providers/{agent-resolver,runner-types,
                                normalize-claude,codex-cli-session}.ts,
                                core/src/model-profiles.json
C.4  Research substrate          core/src/research/{orchestrator,query-plan,
                                evidence-pack,web-search,user-agent}.ts +
                                research/adapters/{arxiv,github-search,
                                semantic-scholar}.ts
C.5  Telemetry & observability   core/src/events/{envelope-bus,task-envelope,
                                wire-schema,to-wire-record,consent-rules,
                                telemetry-uploader,jsonl-writer,log-writer,
                                plain-log-entry,stderr-log-subscriber}.ts
C.6  State stores (in-process)   core/src/unified/task-registry.ts,
                                core/src/stores/{context-block-tool,
                                expand-context-blocks,
                                project-context-registry}.ts
C.7  Distribution                server/src/skill-install/skill-installers/{claude-code,
                                cursor,codex-cli,gemini-cli}.ts +
                                server/src/skill-install/{discover,manifest,
                                skill-manifest-sync,disabled-state,
                                include-utils}.ts +
                                server/src/skills/mma-*/SKILL.md
```

A single request reads as a path: the horizontal axis tells you *which stage*, the vertical axis tells you *which file does that stage's work for this tool*, and the substrate tells you *which capability the stage borrows from*.

## Provider runners

Each provider runner (`core/src/providers/claude.ts`, `core/src/providers/codex.ts`) encapsulates provider-specific I/O (Anthropic Claude SDK, Codex CLI subprocess). Result assembly is handled per-provider: `providers/normalize-claude.ts` for Claude, `providers/codex-cli-session.ts` for Codex. Agent resolution (`providers/agent-resolver.ts`) maps task-type tiers to configured agents. Provider-specific session management, tool categories, and normalization are co-located in the providers directory.

## Request lifecycle (concrete trace)

1. **Ingress** — `server/src/http/server.ts` routes `POST /task?cwd=<abs>` to the unified handler (`handlers/unified-task.ts`). The handler validates the `type` discriminator via the Zod discriminated union in `unified/task-input-schema.ts`, reserves a `ProjectContext` per cwd, and registers a `TaskRegistry` entry.
2. **Pipeline** — The unified two-phase pipeline (`unified/two-phase-pipeline.ts`) loads skill prompts from `skills/<type>/implement.md` + `review.md` via `unified/skill-loader.ts`, resolves agent tier from `TYPE_REGISTRY`, and drives the implement + review phases.
3. **Dispatch** — The pipeline picks a provider via the type's default tier, invokes the provider runner, and bounds execution via provider-level `wallClockDeadline` + `abortSignal`.
4. **Review** — When `reviewPolicy` is `reviewed`, the pipeline runs a second-phase review pass. When `none`, the review phase is skipped.
5. **Reporting** — Results are aggregated into the uniform envelope, telemetry events emitted via the event bus, and the result stored in `TaskRegistry` for retrieval via `GET /task/:taskId`.

**Same-repo dispatch serialization:** Write types (`delegate`, `execute_plan`) with `worktree: true` in `TYPE_REGISTRY` isolate their work in git worktrees. Tasks that share a git toplevel run in their own worktree; tasks in different repos run in parallel. This eliminates commit-stage and implement-stage races within a single repo. Read-only types (`audit`, `review`, `debug`, `investigate`, `research`) keep full `Promise.all` fan-out.

## Testing layers

| Layer | Location | Purpose |
|---|---|---|
| Unit | `tests/<module>/*.test.ts` | Per-file behavior |
| Integration | `tests/contract/**/*.test.ts`, `tests/unified/*.test.ts` | Two-phase pipeline tests and HTTP integration |
| Contract | `tests/contract/**` | HTTP envelopes + skill manifest + observability + route enumeration; goldens under `tests/contract/goldens/` |
| Perf | `tests/perf/*.test.ts` | Baseline + budget enforcement |

Mock-provider pattern: `mockProvider` / `failProvider` from `tests/delegate.test.ts` and `tests/contract/fixtures/mock-providers.ts`. Never call real LLM APIs in tests.

## Key observables

- Route manifest: `tests/contract/goldens/routes.json` (canonical list of HTTP routes; change breaks the manifest test).
- Observability manifest: `tests/contract/goldens/observability/event-manifest.json` (required event + field set a replayed scenario must emit).
- Per-endpoint + per-phase goldens: `tests/contract/goldens/endpoints/<type>-<phase>.json`.

## Maintainer migration appendix

Old path → new path map (for readers coming from pre-3.2.0):

| Old | New |
|---|---|
| `packages/core/src/run-tasks/` (execute-task, reviewed-lifecycle, etc.) | Deleted. The unified two-phase pipeline (`unified/two-phase-pipeline.ts`) handles all dispatch + review |
| `packages/core/src/lifecycle/` (LifecycleDriver, StagePlanBuilder, stage handlers) | Deleted in v5.2.0. Bounded execution is provider-level via `wallClockDeadline` + `abortSignal` |
| `packages/core/src/tools/` (per-tool briefSlots, tool-configs) | Replaced by `core/src/skills/` (per-type implement.md + review.md) + `unified/type-registry.ts` |
| `packages/core/src/routing/` (AgentResolver, ToolSurfaceRegistry) | `AgentResolver` moved to `providers/agent-resolver.ts`; ToolSurfaceRegistry deleted |
| `packages/core/src/executors/` | Deleted. Pipeline drives providers directly |
| `packages/core/src/types.ts` (654 LOC dumping ground) | Cross-cutting only; domain types in `types/` (task-spec, run-result, goal, stage-stats, etc.) |
| `packages/mcp/` | Deleted. All MCP-layer concerns now live under `packages/server/` (HTTP service) + `packages/server/src/skills/` (distributed skill markdown) |
| `packages/server/src/install/` | Renamed to `packages/server/src/skill-install/` |
| Clarification flow (clarification-store, force-clarification, confirm route, `mma-clarifications` skill) | Deleted in v4.0. Routes ambiguous briefs by picking the most likely interpretation. `proposedInterpretation` is no longer in the response envelope |
| `core/src/intake/` directory (pipeline, classify, resolve, field-inferer, brief-compiler classes) | Removed. Skills are plain markdown per type at `core/src/skills/<type>/` |
| 5-field `TokenUsage` (`cachedCreationTokens`, `reasoningTokens`, …) | 4-field canonical shape: `{inputTokens, outputTokens, cachedReadTokens, cachedNonReadTokens}`. `outputTokens` includes reasoning. SCHEMA_VERSION bumped to 6 |
| `reviewPolicy` values `'spec_only'` / `'off'` / `'full'` / `'quality_only'` / `'diff_only'` | Removed. Closed enum is `'reviewed' | 'none'` |
| `BatchRegistry`, `batch-registry.ts` | Replaced by `TaskRegistry` (`unified/task-registry.ts`). Polling via `GET /task/:taskId` |

### v5.0.0–v5.2.0 — Unified task API + lifecycle dissolution

The `packages/core/src/intake/`, `core/src/tools/`, `core/src/routing/`, `core/src/executors/`, `core/src/lifecycle/`, and `core/src/run-tasks/` directories were all removed. The unified task API (`POST /task`) replaced per-tool HTTP endpoints. All task types now flow through `core/src/unified/two-phase-pipeline.ts` with skill prompts at `core/src/skills/<type>/implement.md` + `review.md`.

Bounded execution moved from a dedicated lifecycle layer to provider-level `wallClockDeadline` + `abortSignal` in `core/src/bounded-execution/`. Wire schema bumped to v6.

Where to add:

- **A new provider:** `core/src/providers/<name>.ts`. Update `providers/provider-factory.ts`.
- **A new task type:** Add to `TASK_TYPES` + `TYPE_REGISTRY` (including `targetAcceptance`) in `core/src/unified/type-registry.ts`. Add Zod schema variant in `core/src/unified/task-input-schema.ts`. Add refiner schema in `core/src/unified/refiner-schemas.ts` if the output shape is typed. Add skill prompts at `core/src/skills/<name>/implement.md` + `review.md`. Add `server/skills/mma-<name>/SKILL.md` for the caller-facing prompt.
- **A new contract test:** `tests/contract/<area>/<topic>.test.ts`; goldens under `tests/contract/goldens/<area>/<topic>.json`. Capture via the `it.todo` → external capture script → flip pattern (never fail-first-then-copy).
- **A new observability event:** emit structured log line from a handler; add required fields to `tests/contract/goldens/observability/event-manifest.json`; the replay test picks it up automatically.

## Further reading

- `.claude/CLAUDE.md` — local conventions for contributors.
- `DIRECTION.md` — product north star.

## Known limitations

### Git worktrees + a shared daemon

`mma serve` writes worker output relative to the dispatched `?cwd=`. Pairing a
**git worktree** with a daemon started from a *different* worktree is not currently
guaranteed to isolate filesystem writes on every platform (observed escaping to the
daemon's startup cwd under some Bun/Windows configurations). Until the root cause is
fixed, prefer one of:

- run the daemon from the directory you intend workers to write to, or
- do the work on a branch in a single worktree.

A write that escapes the dispatched cwd is **not silently accepted** — the task seals
`failed` with `tool_sandbox_cwd_violation` (see `recordTaskCompletedHandler`).
