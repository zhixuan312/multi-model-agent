# Architecture

One-page orientation for maintainers. Deeper content lives alongside code.

multi-model-agent (MMA) is the engine layer of a solution development lifecycle: a general five-stage practice (explore, spec, plan, execute, verify) that this product carries software engineering's verification discipline into, rather than a software-only pipeline. MMA defines the lifecycle method — what each stage must establish and what makes an advance honest. The caller (a practitioner directly, the `mma-flow` packaged skill, or Forge) owns lifecycle progression and durable workflow state; the engine executes one bounded stage per request, validates the contract at the boundary, and records evidence — see `DIRECTION.md`'s refusal of hidden workflow state. Software remains one supported technique, selected by the caller rather than assumed from the deliverable; it is not the definition of the lifecycle the axes below describe.

## The three axes

multi-model-agent is organized around three axes. A request is a *path* through them, not a region.

- **Horizontal** — request flow: a request descends through five stages from the HTTP boundary to the terminal envelope.
- **Vertical** — tool surface: each task type exists as a stack of files at fixed layers (registry → schema → skill → pipeline → ...). Adding a type means filling the stack top-to-bottom; the layers themselves never change shape.
- **Substrate** — orthogonal capabilities (auth, cost, telemetry, runners, research) every stage and every type borrows from.

**Package rule of thumb:** `packages/core` has no knowledge of HTTP. `packages/server` splits into two one-way layers: `server/src/http/` (thin transport adapters — parse, authenticate, serialize) and `server/src/application/` (the `ExecutionRuntime` and everything between wire validation and the core pipeline). HTTP depends on application, never the reverse; neither contains LLM-calling logic — that stays in core behind the unified two-phase pipeline.

## Horizontal axis — the five stages

Each stage decomposes into sub-layers that always run in this order. The pipeline is one-way.

```
Stage 1 — INGRESS  (transport boundary — thin adapters only)
  1.1  Transport          server/src/http/server.ts
  1.2  Authentication     server/src/http/auth.ts
  1.3  Unified handlers   server/src/http/handlers/unified-task.ts
                          (POST /task + GET /task/:taskId + DELETE /task/:taskId)
                          Builds a CallerContext (application/caller-context.ts)
                          from the request; owns no task logic.
  1.4  MCP adapter        server/src/mcp/{mcp-adapter,tool-surface}.ts
                          (POST /mcp, streamable HTTP, stateless; seven tools —
                          mma_run / mma_task_get / mma_task_wait / mma_task_list /
                          mma_task_cancel / mma_context_block_create /
                          mma_context_block_delete — over the SAME
                          ExecutionRuntime — MCP wire types never leave this
                          directory; mma_run's request schema is generated from
                          the task-input Zod union, never hand-written; caller
                          attribution reuses http/middleware/caller-identity —
                          a sibling within this same stage, so both adapters
                          resolve X-MMA-Client through one allowlist)

  1.5  MCP App resource   server/src/mcp/execution-artifact.ts +
                          server/src/ui/execution/ (browser bundle, built by Vite
                          into dist/ui/execution.html and served as
                          ui://mma/execution.html). This is the ONLY browser-side
                          code in the repo: it runs inside the host's iframe, holds
                          no credential, and reaches the daemon solely through the
                          host's callServerTool broker. It is excluded from the
                          server tsconfig (DOM libs, bundler resolution) and has its
                          own tsconfig.ui.json so it stays type-checked and linted.
                          The capability is advertised only when the bundle exists.

Stage 2 — ADMISSION + PREPROCESSING  (application layer)
  2.1  Zod validation      core/src/unified/task-input-schema.ts (discriminated union,
                           parsed at the adapter boundary)
  2.2  Execution runtime   server/src/application/execution-runtime.ts
                           (tier/agent/skill resolution, project reservation,
                           registry + durable-store admission, async scheduling)
  2.3  cwd validation      server/src/application/cwd-validator.ts
  2.4  Type registry       core/src/unified/type-registry.ts (TYPE_REGISTRY → defaults, sandbox, writeRoute)
  2.5  Skill loading       core/src/unified/skill-loader.ts (implement.md + review.md per type)
  2.6  Preprocessors       server/src/application/preprocessors/ (per-type, keyed off
                           TaskType: execute_plan contract parse, journal candidate
                           injection, spec/plan outputPath, research evidence pack)
  2.7  Execution scope     server/src/application/execution-scope.ts (per-execution
                           abort channel + LIFO cleanup registry, created before
                           preprocessing, drained in one finally)

Stage 3 — DISPATCH  (pick agent, run implementer)
  3.1  Agent resolution   core/src/providers/agent-resolver.ts +
                          core/src/config/model-profile-registry.ts
  3.2  Two-phase pipeline core/src/unified/two-phase-pipeline.ts
  3.3  Provider invoke    core/src/providers/{claude,codex}.ts
                          via providers/provider-factory.ts
  3.4  Bounded execution  core/src/bounded-execution/cost-compute.ts
                          (provider-level wallClockDeadline + abortSignal)

Stage 4 — REVIEW  (cross-agent verdict via two-phase pipeline)
  4.1  Reviewer execution core/src/unified/two-phase-pipeline.ts (second phase)
  4.2  Finding parsing    core/src/unified/reviewer-output-parser.ts
  (When reviewPolicy is 'none', the review phase is skipped entirely.)

Stage 5 — REPORTING  (parse, derive, compose, persist, emit)
  5.1  Evidence parsing   core/src/reporting/extract-evidence-sections.ts
  5.2  Status derivation  inline in core/src/unified/two-phase-pipeline.ts
                          (done | done_with_concerns from the reviewer parse);
                          the runtime maps an aborted pipeline whose OWN scope
                          fired to terminal `cancelled`
  5.3  Sentinels          core/src/reporting/not-applicable.ts
  5.4  Telemetry emit     core/src/events/{envelope-bus,task-envelope,wire-schema,
                          to-wire-record,consent-rules,telemetry-uploader}.ts
                          (envelope construction: server/src/application/
                          {telemetry-snapshot,result-shape}.ts)
  5.5  Persistence        core/src/unified/task-registry.ts (in-memory index) +
                          server/src/application/execution-store.ts (durable
                          SQLite mirror — terminal results survive restart),
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
Layer L.7  Installer hook   server/src/provisioning/writers/{claude-code,claude-desktop,
                            codex,antigravity,cursor,opencode,windsurf}.ts via
                            provisioning/service.ts  (per-client, ownership-safe writer)
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
| `orchestrate` | none | no | cwd-only | mma-orchestrate |
| `spec` | reviewed | no (in-place) | cwd-only | mma-spec |
| `plan` | reviewed | no (in-place) | cwd-only | mma-plan |

Two invariants the layered stack enforces:

- **Vertical layers don't reach across.** A schema (L.2) never imports bespoke output (L.5); a skill markdown (L.6) is plain prose with no code dependency. New types fill the stack top-to-bottom — they don't sneak in mid-stack.
- **Horizontal stages don't reach backwards.** Reporting (5) reads from Review (4) outputs; Review never reads from Reporting. The pipeline is one-way except for the rework sub-loop inside Stage 4.

## Substrate — orthogonal capabilities

These layers underlie every stage and every tool. They aren't on either axis; they're the floor both axes stand on.

```
C.1  Identity & sandboxing      core/src/identity/{claude-oauth,secret-redactor}.ts,
                                server/src/http/auth.ts,
                                server/src/application/cwd-validator.ts,
                                core/src/transport/loopback-enforcer.ts,
                                core/src/providers/claude-cwd-confinement.ts
                                (PreToolUse hook: cwd-only + read-only enforcement)
C.2  Bounded execution           core/src/bounded-execution/cost-compute.ts,
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
C.6  State stores                core/src/unified/task-registry.ts (in-memory),
                                server/src/application/execution-store.ts
                                (durable SQLite at <stateDir>/executions.db:
                                admission before handle return, CAS terminal
                                transitions, TTL pruning),
                                server/src/application/{reconcile,
                                worker-pid-recorder}.ts (boot crash fencing:
                                kill surviving detached codex process groups,
                                then mark executions interrupted/retryable),
                                core/src/stores/{context-block-tool,
                                project-context-registry}.ts
C.7  Distribution                server/src/provisioning/{capability-registry,roster,
                                owned-files,registration-writer,marker-store,
                                service,inventory,real-port}.ts +
                                server/src/provisioning/writers/{claude-code,
                                claude-desktop,codex,antigravity,cursor,opencode,
                                windsurf}.ts +
                                server/src/skill-install/{discover,manifest,
                                include-utils}.ts +
                                server/src/skills/mma-*/SKILL.md
```

A single request reads as a path: the horizontal axis tells you *which stage*, the vertical axis tells you *which file does that stage's work for this tool*, and the substrate tells you *which capability the stage borrows from*.

## The Deliverable Contract

The Deliverable Contract (`core/src/unified/deliverable-contract.ts`) is the declared set of facts a
caller and the engine agree on for one solution: `kind` (a free-form label the agent proposes and the
human confirms — the contract has no kind registry, no `subtype`, and no per-task verification-strictness
field), `audience`, `artifacts` (declared output paths), `acceptance` (criteria, each with an explicit
verification `method` of `command`, `agent-review`, or `human`, and at least one `reference` to check
against), and `disposition` (how the finished solution reaches the caller: `pr`, `commit-in-place`, or
`deliver-file`).

A contract widens through three states, so validation grows stricter as the caller's intent firms up:

- `draft` (exploration) — only `audience` is required.
- `proposed` (spec / plan) — `kind`, `artifacts`, `acceptance`, and `disposition` are all required.
- `approved` (execution onward) — adds a `contractApproval` whose `contractDigest` must equal
  `canonicalContractDigest(contract)`, a filesystem-free SHA-256 digest computed from the contract's
  content (key order, artifact order, and string normalization are all canonicalized first; `state` and
  `contractApproval` itself are excluded, since they describe lifecycle, not content). Only an
  `approved` contract crosses the REST or MCP wire — `draft` and `proposed` contracts stay on disk in
  spec/plan frontmatter and are never sent to the engine.

Validation splits across two layers because only the server has a filesystem to check against:

- **Core** (`unified/deliverable-contract.ts`, pure Zod, no disk access) checks shape and the
  digest match: artifact paths are lexically relative (no absolute prefix, no `..` segment), acceptance
  ids and normalized artifacts are unique, an empty artifact set requires at least one terminal
  `command` criterion (no vacuous completion), and an `approved` contract's digest matches its content.
- **Server boundary** (`server/src/application/deliverable-contract-validator.ts`,
  `validateDeliverableContractBoundary`) checks what needs the live filesystem and the task's `cwd`:
  realpath containment of every declared artifact root and path (and of any `CommandCheck.cwd`), and
  disposition feasibility (`pr` and `commit-in-place` require a git repository; `deliver-file` does
  not). Both the REST handler (`server/src/http/handlers/unified-task.ts`) and the MCP adapter
  (`server/src/mcp/mcp-adapter.ts`) call
  this same function with the same already-Zod-validated contract, so a caller sees identical
  field-specific errors regardless of transport. This check runs before `ExecutionRuntime.submit`, so a
  boundary rejection never opens a provider session.

An optional `deliverable` field (an `ApprovedContract`) is wired onto exactly four task types —
`spec`, `plan`, `execute_plan`, and `review` (`core/src/unified/task-input-schema.ts`) — the routes a
contract governs. Every other task type omits the field entirely, so it cannot appear on their input.
Omitting `deliverable` stays valid: an unmanaged direct call carries none.

A separate, optional `method` field (`z.string()` matching `<name>@<version>`, wired onto every one
of the twelve `TASK_TYPES`, SPEC-005 Method Registry) names a registered **Method** — a procedure
declaration (`packages/core/src/initiative-record/`) plus committed guidance Markdown
(`packages/core/src/methods/<name>/guidance.md`) that `ExecutionRuntime.submit()` resolves and
injects into both the implementer's and reviewer's prompts. It answers *how* to do the work; `kind`
answers *what* the deliverable is; `audit`'s own `subtype` field (which criteria set examines the
artifact) is a third, unrelated axis. A syntactically valid but unregistered identifier is rejected
synchronously as `unknown_method` (HTTP 400) before any execution handle, provider session, or
outbox row exists. Omitting `method` loads the generic, deliverable-neutral implementer skill.

## Provider runners

Each provider runner (`core/src/providers/claude.ts`, `core/src/providers/codex.ts`) encapsulates provider-specific I/O (Anthropic Claude SDK, Codex CLI subprocess). Result assembly is handled per-provider: `providers/normalize-claude.ts` for Claude, `providers/codex-cli-session.ts` for Codex. Agent resolution (`providers/agent-resolver.ts`) maps task-type tiers to configured agents. Provider-specific session management, tool categories, and normalization are co-located in the providers directory.

## Request lifecycle (concrete trace)

1. **Ingress** — `server/src/http/server.ts` routes `POST /task?cwd=<abs>` to the unified handler (`handlers/unified-task.ts`). The handler validates the `type` discriminator via the Zod discriminated union in `unified/task-input-schema.ts`, builds a `CallerContext` (client name, project root) from the request, and hands off to `ExecutionRuntime.submit()`. It owns no task logic.
2. **Admission** — The runtime (`application/execution-runtime.ts`) resolves tiers/agents/skills, reserves a `ProjectContext` per cwd, registers a `TaskRegistry` entry AND persists the admission record to the `ExecutionStore` before the 202 handle is returned, creates the `ExecutionScope` (the live abort channel), and schedules the async execution.
3. **Preprocessing** — The per-type preprocessor (`application/preprocessors/`) runs inside the scope: execute_plan contract parsing + path-safety + collision dry-run, journal candidate injection, spec/plan outputPath derivation, research evidence gathering. A `PreprocessFailure` fails the task terminally with zero provider sessions.
4. **Pipeline** — The unified two-phase pipeline (`unified/two-phase-pipeline.ts`) drives implement + review, threading the scope's `abortSignal` into every provider session; provider-level `wallClockDeadline` bounds each turn, and cancellation checkpoints at phase boundaries stop the pipeline before the engine commits (a cancelled run leaves partial edits uncommitted in the caller's tree, visible to `git status`). When `reviewPolicy` is `none`, the review phase is skipped. A dead implementer turn (0 assistant turns, empty output) fails terminally before review — never reviewed into a fabricated answer.
5. **Reporting** — Results are aggregated into the uniform envelope, telemetry emitted via the event bus, and the terminal state CAS-written to BOTH `TaskRegistry` and `ExecutionStore` for retrieval via `GET /task/:taskId` (which falls back to the store after a restart). An aborted pipeline whose own scope fired maps to terminal `cancelled`.

**Cancellation** — `DELETE /task/:taskId` sets the cancellation-requested flag (a flag, not a state), fires the scope's abort channel, and returns 202. Provider guards tear the worker down (codex: process-group SIGTERM→SIGKILL; claude: SDK abort). The task reaches terminal `cancelled` unless completion won the race — first writer wins, no post-terminal mutation.

**Restart** — Task IDs and terminal results survive in `<stateDir>/executions.db`. On boot (before the listener accepts), `reconcileOnBoot` finds pending records owned by dead daemons, SIGKILLs any surviving detached codex worker group (verified by command line so a reused pid is never signalled), then marks each execution `interrupted` with a retryable `daemon_restarted` envelope. Execution is never resumed — the caller retries with a new task. Dev watch mode sets `MMA_DEV_NO_RECONCILE=1` so tsx restarts don't kill in-flight work.

**Who the daemon is** — the daemon records itself at `<stateDir>/daemon.pid` (pid, port, bind, version, bootId, startedAt) after a successful bind, and removes it on graceful shutdown. `mma stop` / `restart` / `update` resolve the daemon from that record, confirm identity against its own `GET /status`, and fall back to the port's listening owner only when the record is missing or stale — never by matching a process name. Before signalling, and again before every escalation step, the target's command line is verified (the same rule reconciliation applies to worker pids), so a recycled pid is never signalled. An occupied port raises `PortInUseError` from the listener rather than an uncaught `EADDRINUSE`, so "a daemon is already running" reads as an explanation naming the owner.

**Caller-owned branches:** the engine never creates a branch or a git worktree. Every caller (`/mma:flow`, a Forge project, a Forge loop) cuts and checks out `mma/<date>-<slug>` BEFORE dispatching, so a second isolation layer inside the engine would only duplicate work the caller already did. `delegate` and `execute_plan` are the only types with `writeRoute: true` in `TYPE_REGISTRY`: they capture a git baseline (HEAD + `git status --porcelain`) before the worker starts, let the worker edit the submitted cwd in place, then commit there from the daemon process — outside every worker sandbox. `output.filesChanged` is `git diff --name-only <headBeforeDispatch>..HEAD`, engine-measured rather than worker-reported. A task that changed nothing does not commit, so a no-op never sweeps a caller's unrelated work into a commit. Workers are denied git entirely (default-deny allow-list: only `status`/`log`/`diff`/`show`, and only with safe flags), and the engine refuses to commit if a worker moved HEAD or switched branch. The other write types (`spec`, `plan`, `journal_record`, `orchestrate`) write artifacts under `.mma/`, which repos gitignore, so there is nothing to commit. Read-only types keep full `Promise.all` fan-out.

## Testing layers

| Layer | Location | Purpose |
|---|---|---|
| Unit | `tests/<module>/*.test.ts` | Per-file behavior |
| Integration | `tests/contract/**/*.test.ts`, `tests/unified/*.test.ts` | Two-phase pipeline tests and HTTP integration |
| Contract | `tests/contract/**` | HTTP envelopes + skill manifest + observability + route enumeration; goldens under `tests/contract/goldens/` |
| Perf | `tests/perf/*.test.ts` | Baseline + budget enforcement |

Mock-provider pattern: `mockProvider` (scenario or per-turn `sequence`), `throwingProvider`, and `capExhaustingProvider` from `tests/contract/fixtures/mock-providers.ts`. Never call real LLM APIs in tests.

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
| `packages/core/src/types.ts` (654 LOC dumping ground) | Cross-cutting only; domain types in `types/` (task-spec, run-result, config, enums) |
| `packages/mcp/` | Deleted. All MCP-layer concerns now live under `packages/server/` (HTTP service) + `packages/server/src/skills/` (distributed skill markdown) |
| `packages/server/src/install/` | Renamed to `packages/server/src/skill-install/` |
| `packages/server/src/skill-install/skill-installers/{claude-code,cursor,codex-cli,gemini-cli}.ts` + `manifest.ts`-driven per-client writer dispatch, `skill-manifest-sync.ts`, `disabled-state.ts` (`~/.mma/skills-disabled.json`) | Deleted. Replaced by `packages/server/src/provisioning/` — a capability registry (`capability-registry.ts`) over the canonical `ClientId` roster (`packages/core/src/clients/client-id.ts`), a declared-over-detected roster resolver (`roster.ts`), ownership-safe registration/skill writers (`registration-writer.ts`, `owned-files.ts`, `writers/*.ts`), durable provisioning markers (`marker-store.ts`), and one atomic orchestrator (`service.ts`). The `codex-cli` / `gemini-cli` client ids are gone — the canonical roster is `claude-code`, `claude-desktop`, `codex`, `antigravity`, `cursor`, `vscode`, `opencode`, `windsurf`. The sticky off-switch is now `clients.<ClientId>: 'off'` in `~/.mma/config.json`, not a sentinel file |
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
