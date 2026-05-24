# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.8.0] - 2026-05-24

Adds a project-scoped, cross-agent **learnings journal** (the Karpathy "WikiLLM" pattern) plus a deterministic-commit / diff-grounded-review hardening of the write lifecycle. Two new routes — `journal-record` (write) and `journal-recall` (read) — let any agent durably record what was learned and recall it later as a connected graph of markdown ADR nodes under `.mmagent/journal/`. `SCHEMA_VERSION` stays 5; the only wire change is two additive `route` enum values, disclosed in PRIVACY.md in lockstep. Build green, full Vitest suite passing, and a 16-scenario live full-pipeline smoke clean (0 hard-fails).

### Added

- **Journal routes (core + server).** `journal-record` (write route) integrates ONE learning into the existing journal graph — choosing create / refine / supersede / merge with typed edges (`supersedes`, `refines`, `relates`, `depends-on`, `contradicts`, `parent`) — and `journal-recall` (read route) answers a natural-language query against the graph. Nodes are markdown files with YAML frontmatter (id, title, status, tags, date, links, supersededBy) plus `## Context` / `## Consequences`, stored under `.mmagent/journal/` with an `index.md` catalog and append-only `log.md`. Wired into every closed route set (Route union, wire-schema enum, stage-io, tier policy, completion derivation, read-route criteria).
- **Journal skills (server).** `mma-journal-record` and `mma-journal-recall` ship as installable skills — 13 skills now install (overview + 12 `mma-*`).
- **Journal-fit cross-agent review (core).** `journal-record` runs a dedicated node-validation reviewer (`journal-review-prompt.ts`) — checking frontmatter, edge vocabulary, schema, `.mmagent/journal/` confinement, and dedup integrity — instead of the code-oriented spec/quality reviewers, reusing the shared verdict/findings output format. Fixes the spurious `changes_required` + zero-findings → `failed` outcome a code reviewer produced on a valid markdown node.
- **Deterministic commit-message composer (core).** Write-route commit subjects are composed deterministically from the task descriptor (Fix A), producing clean conventional subjects with no chain-of-thought or orientation-prompt leakage.

### Changed

- **Diff-grounded first-pass review (core).** The reviewer receives the actual cumulative diff (truncated to a byte cap) as ground truth, with guardrails against claiming files are missing/untracked (Fix B).
- **Completion reconciled against objective signals (core).** Worker self-assessment is reconciled with the commit-gate payload kind and the review verdict before sealing terminal status, extending the 4.7.8 deterministic completion gate (Fix C).
- **Research pipeline (core).** `/research` now surfaces the sources-used table on the per-task report, throttles Brave requests, and removes the `rss` / `web_fetch` adapters — the adapter surface is now `arxiv`, `semantic_scholar`, `github_repo`, `github_code`, `brave`.

### Notes

- **`SCHEMA_VERSION` stays 5.** The only wire-schema change is two additive `route` enum values (`journal-record`, `journal-recall`) plus their entries in the reviewed/quality-only route sets. PRIVACY.md updated in lockstep to disclose the two new route names. No new telemetry field; no new kind of data collected.

## [4.7.20] - 2026-05-24

Read-route workers now register their terminal report as a reusable context block, surfaced on each `/batch` per-task result as `contextBlockId`. This lets the calling agent run delta follow-ups (e.g. "round 1 found these N things — are they resolved?") by passing a prior result's `contextBlockId` straight into the next call's `contextBlockIds`, with no manual block registration. Write routes return `contextBlockId: null` — their durable record is the commit, not a prose block. This finishes the v4-phase-3 "universal terminal block registration" design that was added but never wired. Verified on a clean `npm run build` + full Vitest run (2094/2094) and a live full-pipeline smoke confirming non-null `contextBlockId` on every read route and `null` on every write route. `SCHEMA_VERSION` stays 5 — the telemetry wire schema is unchanged; the new field rides only on the `/batch` per-task response.

### Added

- **lifecycle (core).** Read routes (`audit` / `review` / `debug` / `investigate` / `research`) auto-register a per-task terminal context block — the sealed report (headline + findings) rendered to markdown — via the now-wired `TerminalBlockRegistrar`. The block id is recorded in `BatchRegistry` and carried on `TaskEnvelope.contextBlockId`.
- **server.** `GET /batch/:id` per-task results now project `contextBlockId`: a non-null block id on read routes, `null` on write routes. New `renderTerminalReportMarkdown` helper produces the block content.

### Fixed

- **lifecycle (core).** `buildExecutionContext` now threads `batchRegistry` onto the worker execution context. Previously only `contextBlockStore` was threaded, so the terminal stage's registration guard returned early and `contextBlockId` was silently `null` on every read route. Caught by the live full-pipeline smoke, not unit tests.

### Changed

- **lifecycle (core).** Renamed the internal terminal-block field `terminalBlockId` → `contextBlockId` across `TerminalPayload`, `LifecycleState`, and the terminal handlers. The unrelated `register-context-block` route field `blockId` is untouched. Deleted the broken inline `store.register({id,content})` path (wrong signature, swallowed) in favor of the registrar.
- **skills.** Reconciled the terminal-block field name to `contextBlockId` across all skills: read skills document the non-null id + the null-filtered delta recipe; write/retry skills (`delegate` / `execute-plan` / `retry`) state `contextBlockId` is `null`. Removed the contradictory `blockId` wording in `mma-investigate`.

## [4.7.19] - 2026-05-23

Behavior-neutral dead-code removal. The attempt/rework budget machinery (`ATTEMPT_BUDGETS` plus the `attemptBudget` / `attemptIndex` fields on `LifecycleState`) was set-but-never-read state: the v5 lifecycle bounds its review→rework loop via the linear `STAGE_PLAN` walk, not a budget counter, so removing it changes nothing observable. Telemetry (`SCHEMA_VERSION` stays 5), stage names/order, routes, tools, and agent-facing output are identical before and after. Verified on a clean `npm run build` + full Vitest run (2081/2081) and a full-pipeline real-dispatch smoke (`npm run smoke:full`) that passed 15/15, exercising the review→rework path end-to-end.

### Removed

- **lifecycle (core).** Deleted the `ATTEMPT_BUDGETS` constant and the dead `attemptBudget` / `attemptIndex` fields from `LifecycleState`, along with their write sites in the dispatcher and the stage-progression simulator. Loop termination is unchanged — it comes from the finite `STAGE_PLAN`, never from these counters.

### Changed

- **lifecycle (core).** Renamed `rework-budget.ts` → `tool-category.ts`; the file now holds only the still-used `ToolCategory` type, and its five importers were repointed.

## [4.7.18] - 2026-05-23

Adds a first-class off switch for MMA: `mmagent disable` / `mmagent enable`. Disabling MMA previously meant manually deleting skill files — which the `npm install` postinstall hook silently undid on the next upgrade. This release makes turning MMA off a supported, upgrade-surviving operation.

### Added

- **`mmagent disable [--target=<client>] [--all-targets] [--dry-run] [--json]`** — removes every shipped skill from the resolved clients, drops their manifest entries, and writes a sticky sentinel at `~/.multi-model/skills-disabled.json`.
- **`mmagent enable [...]`** — clears the sentinel and reinstalls via the existing `sync-skills` upsert. A bare `enable` restores every client that was turned off, including ones scoped with `--target` (e.g. a prior `disable --target=cursor`).
- **`sync-skills` honors the sentinel** — the `npm install` postinstall path no longer re-enables skills the user deliberately removed. The sentinel is target-aware, so `disable --target=cursor` still lets claude-code sync normally.

### Notes

- The daemon is untouched — disabling only removes the skill adapters the client reads, the sole path MMA is invoked through (per DIRECTION.md).
- Cursor skills are project-local: `disable --target=cursor` removes them from the current directory, but the off-pin is global. See the README "Disabling / re-enabling" section.

## [4.7.17] - 2026-05-22

Behavior-neutral cleanup baseline. A verified, iterative dead-code + duplication sweep across `packages/core` and `packages/server` to consolidate the v4 codebase into one-implementation-per-concept shape before the next features land. **Nothing observable changes** — telemetry wire data (`SCHEMA_VERSION` stays 5, emitted events unchanged), logs, stage names/order, tools, routes, and agent-facing output are all identical before and after. Each removal was confirmed zero-reference repo-wide (core + server + tests) and gated on a clean `npm run build --workspaces` + full Vitest run; the full-pipeline smoke (`npm run smoke:full --wait-flush`) passed 15/15 with the backend DB landing 18/18 on the built artifact.

### Removed

- **Orphaned files (core).** `lifecycle/stage-stats.ts` (zero importers — the lifecycle uses `merge-stage-stats.ts`), the dead report-parser slots `reporting/report-parser-slots/{debug-report,register-context-block-report}.ts` (their tool-configs use `noStructuredReportSchema` / an inline parser, not these schemas), and `reporting/headline-templates/register-context-block.ts`.
- **Dead exported symbols (core).** `ParsedConfigSuccess` / `ParsedConfigFailure` / `ParseConfigResult` (`config/schema.ts`), `PlainLogKind` (`events/plain-log-entry.ts`), `clampToolCallCount` / `clampFilesReadCount` (`events/to-wire-record.ts`), the unused wire-schema declarations `Os` / `SeverityBin` / `UploadBatchSchema` / `StageEntryType` / `StageEntryInternal` / `UploadBatchType` / `ErrorCodeType` / `FindingsBySeverity` (`events/wire-schema.ts` — none emitted; `SCHEMA_VERSION` unchanged), `normalizeStageLabel` (`lifecycle/stage-progression.ts`, orphaned by 4.7.16's `stageProgress` removal), `AdapterCallContext` (`research/adapters/types.ts`), `closeDispatcher` / `_ResearchFetchCfg` (`research/web-fetch-helpers.ts`), `strategyRuleResearch` (`tools/research/implementer-criteria.ts`), `TurnTerminationReason` (`types/run-result.ts`), and the unused `ToolSurfaceRegistry.buildHandler` field + `setHandler` method (`tool-surface/tool-surface-registry.ts`).
- **Dead exported helpers (server).** `doInstall` / `doUninstall` (`skill-install/skill-installer-common.ts` — the install flow calls `writeSkillToClient` / `removeSkillFromClient` directly), `isInstalled` + the now-orphaned `getEntry` (`skill-install/manifest.ts`), the orphaned `InstallResult` interface, and `setRecorderForTest` (`telemetry/recorder.ts`).

### Changed

- **Single `SLICE_CAP_BYTES` (core).** `tools/execute-plan/brief-slot.ts` now imports the constant from `plan-extractor.ts` instead of redefining it.
- **Single `TokenUsage` (core).** Canonical definition lives in `types/run-result.ts`; `providers/runner-types.ts` re-exports it (type-only, runtime-erased) instead of declaring an identical copy.

## [4.7.16] - 2026-05-22

Server + core cleanup: removes verified dead code, retires stale `core` package exports, consolidates two real duplications, and collapses the duplicate `/control/retry` route into `/retry` (the one breaking change). Plus two robustness fixes to the full-pipeline smoke harness. Per `development-mode.md` (no back-compat). Build green; 2074 tests pass; full-pipeline smoke verified 15/15 across all four telemetry sinks.

### BREAKING

- **`/control/retry` removed** (`packages/server/src/http/handlers/control/retry.ts` deleted; `packages/server/src/http/server.ts` wiring + route-enum entries removed; `tests/contract/goldens/routes.json` updated). The protocol-level retry twin is gone — use the public **`POST /retry`** route, which is functionally equivalent (same executor, async-dispatch path) and is what the `mma-retry` skill already calls. No client that uses `/retry` is affected.

### Removed

- **Dead code across core + server.** `READ_ONLY_TOOL_NAMES`, `extractWorkerStatus` (whole module), the `gitCommitHandler` back-compat alias, `CostBreakdown`, the unused `lifecycle/index.ts` + `reporting/index.ts` barrels, `wire/register-all-handlers.ts`, `capitalizeStage`, `validateBearerHeader`, the uninvoked first-run `telemetry/notice.ts` module (+ its tests), the dead `blockRegistration` state shim, `normalizeLegacyStageLabel`, `stageProgress`, `errorResult`, and the empty `packages/server/src/index.ts` barrel. Each was confirmed zero-caller before removal.
- **10 stale `@zhixuan92/multi-model-agent-core` package exports** (`packages/core/package.json`) that pointed at `dist/` paths whose `src/` no longer exists (e.g. `./escalation/agent-resolver`, `./lifecycle/handlers/commit-stage`, `./tools/verify/schema`).

### Changed

- **Single fenced-JSON extractor** (`packages/core/src/reporting/extract-fenced-json.ts`). The four report-parser slots (`delegate`, `debug`, `register-context-block`, `execute-plan`) now route their fenced ` ```json ` block parse through one shared `extractFencedJson(text, label)` helper instead of four inline regex + `JSON.parse` copies; each keeps its route-specific error label and downstream schema-shaping.
- **Single shared `UnknownTargetError`** (`packages/server/src/skill-install/skill-installer-common.ts`). `cli/sync-skills.ts` no longer declares its own copy — it imports the canonical class, so `instanceof` checks across the two files agree.
- **Server root barrel** (`packages/server/package.json`). `main` / `types` / the `.` export now point at `./dist/http/server.js` (the real entry) instead of the deleted empty `index.js` barrel. The `./server` subpath is unchanged.
- **Annotate-stage docs** (`packages/core`). Corrected the annotate stage header + `reviewPolicy` doc comments to reflect the LLM-judge layer.

### Fixed

- **Cross-`instanceof` `UnknownTargetError`** (`install`). The duplicate class definitions meant a `UnknownTargetError` thrown from `skill-installer-common` was not caught by `sync-skills`'s `instanceof UnknownTargetError`; consolidating to one class fixes the missed catch.

### Tooling

- **Smoke harness — accurate per-task telemetry count + flush-robust capture** (`scripts/full-smoke/`). The run-level wire-record tally was `sum(results.length)` captured via a per-scenario queue slice, which over-counted (`execute-plan` internal outcomes, `research`) and under-captured (the wire write lands async after the batch returns terminal; the 5-min flusher drains the queue mid-run, breaking the slice). Each scenario now declares expected emissions (`emits` = one per sealed task), and capture unions full-file queue `eventId`s into a baseline-excluded set with a bounded per-scenario settle.
- **Smoke harness — accept labeled commit-skip.** A delegate worker may non-deterministically produce content identical to the seed, so the commit stage legitimately skips with `commitSkipReason=no_diff` and a null `commitSha`. The harness now treats a null `commitSha` *with* a labeled skip reason as PASS; a null `commitSha` with *no* reason still FAILs (the real lost-commit class).

## [4.7.15] - 2026-05-22

Fixes multi-task commit reporting (surfaced by a new full-pipeline smoke harness) and adds that harness as reusable verification tooling. Build green; 2092 tests pass.

### Fixed

- **Multi-task aggregate `commitSha`** (`packages/server/src/http/handlers/control/batch.ts`). The `GET /batch` aggregate `structuredReport` sourced `commitSha` / `commitMessage` from task 0's envelope only, so a multi-task batch whose first task no-op'd (e.g. `execute-plan`, or a `delegate` task that wrote nothing) reported `commitSha: null` even when sibling tasks committed. It now reads from the **first task that actually committed**, and surfaces `commitSkipReason` only when *nothing* committed. (`filesChanged` already unions across tasks.)

### Added

- **Full-pipeline smoke harness** (`scripts/full-smoke/`, `npm run smoke:full`). A reusable, on-demand verification harness that drives a throwaway git mini-project through every route and lifecycle stage against the live server, then checks stages + telemetry across all four sinks — HTTP response, diagnostics JSONL, `telemetry-queue.ndjson`, and the backend Postgres `events_raw` (correlated by `event_id`) — and tears everything down. Flags: `--skip-backend`, `--only=<ids>`, `--strict`, `--wait-flush` (waits out the 5-min telemetry flush to verify backend DB landing). Not part of `npm test`; run by a human on demand.

## [4.7.14] - 2026-05-22

`lifecycle/` component release in two parts. **(1) Per-dispatch parallel execution.** Multi-task dispatch concurrency is now a simple per-dispatch caller choice — `parallel` or `serial` — instead of being derived from whether tasks share a git repo. The 2026-05-16 same-repo serialization and its grouping machinery are retired; git is the safeguard instead, via the already-shipped per-worker commit attribution plus a new per-repo commit mutex that keeps two concurrent same-repo commits from colliding on `.git/index.lock`. **(2) Lifecycle consolidation.** Removes a large body of dead/dormant code across the lifecycle layer, makes the commit gate the single source of commit truth (retiring the `state.commits[]` / `reviewVerdict` mirrors), and fixes commit attribution and commit reporting under concurrent dispatch. Build green; full vitest suite passing.

### Added

- **Per-dispatch `DispatchMode`** (`packages/core/src/lifecycle/tool-config-types.ts`). New `DispatchMode = 'serial' | 'parallel'` plus `dispatchMode` + `dispatchModeOverridable` on `ToolConfig`. `delegate` defaults to `parallel` and accepts a per-request `execution: 'parallel' | 'serial'` override (`tools/delegate/schema.ts`); `execute-plan` is hardcoded `serial` (ordered plan steps) and rejects an `execution` field via its strict schema. Read/assist routes are `parallel`, non-overridable — preserving their existing `Promise.all` fan-out.
- **Per-repo commit mutex** (`packages/core/src/lifecycle/repo-commit-lock.ts`). Process-global `withRepoCommitLock(repoKey, fn)` keyed by git toplevel; serializes the stage+commit section for one repo while letting distinct repos run concurrently. Always releases on throw; idle keys are evicted.
- **`dispatch_mode` on `batch_completed`** (`packages/server/src/http/async-dispatch.ts`). The effective dispatch mode (`serial` | `parallel`) and `task_count` are emitted so operators can diagnose scheduling without the retired group fields.
- **`reviewPayload(state)` accessor** (`packages/core/src/lifecycle/stage-plan-types.ts`) — single read path over `gates.review.payload`, replacing the hoisted `state.reviewVerdict` / `state.reviewFindings` mirrors.
- **`reviewPolicy_none` skip reason** — explicit skip reason instead of a generic `noop` when review is disabled.

### Changed

- **Mode-based scheduler** (`packages/core/src/lifecycle/task-executor.ts`). The dispatch branch now resolves the effective mode and runs either `Promise.all` (parallel) or a serial input-order loop that stops on the batch abort signal — replacing the per-repo grouped-dispatch path. `PARALLEL_SAFETY_SUFFIX` is re-gated on "runs concurrently with siblings" (parallel + >1 task) instead of cross-repo group count, and is now actually wired into dispatch (it was previously orphaned).
- **Commit fields are sourced from the commit gate, end to end.** The annotator builds `structuredReport`'s `commitSha` / `commitMessage` / `commitSkipReason` / `filesChanged` from the committed gate payload (`handlers/annotate-stage.ts`), and the commit outcome is carried onto the per-task envelope at `seal()` (`handlers/terminal-handlers.ts`, `events/task-envelope.ts`) so the GET `/batch` response surfaces the real SHA — the response is built from envelope snapshots, not the (never-populated) executor result.

### Fixed

- **Concurrency-safe commit attribution** (`packages/core/src/lifecycle/handlers/git-commit-handler.ts`). Each worker commits only its own written files via pathspec-scoped `git add -- <files>` / `git commit -- <files>`, sourced from harness-tracked writes rather than a repo-wide diff — so concurrent same-repo workers never sweep in each other's changes.
- **`commitSha` / `commitMessage` were always null in responses.** The batch handler hardcoded them to null (and `entry.result` is never populated); committed tasks now report their real SHA and message. Regression test added.
- **`dispatchMode` missing on 7 tool-configs** — the new required fields were only set on delegate + execute-plan, breaking a clean (`rm -rf dist`) workspace build on audit/review/debug/investigate/research/register-context-block/retry. Also dropped a `stripEvidence()` call in `annotate-prompts.ts` that no longer type-checks.
- **Real `cwd` wired into the pre-task snapshot** so `getRealFilesChanged` (git-truth diff) is no longer inert, and the commit gate no longer pre-skips on worker self-reported `filesChanged`.

### Removed

- **Same-repo grouping machinery** — `lifecycle/task-grouping.ts` (`groupTasksByRepo`/`TaskGroup`), `lifecycle/repo-hygiene.ts` (the sequential prior-task advisory), `ExecutionContext.batchGroupCount` / `attachBatchGroups` / `setBatchGroupingTelemetry`, the `BatchRegistry` `groups` / `groupingTelemetry` state + methods, the 202 pending-headline group composer, and the `group_count` / `group_sizes` / `serialization_applied` event fields. The `serializeSameRepo` `ToolConfig` flag is gone.
- **`runTasks()` test-only public API** — `executeTask` is the single entry point (the delegate test was migrated). **See BREAKING.**
- **Dead lifecycle code** — `autoCommit` field/config/override branch, `qualityReviewPromptBuilder` hook, `escalationProvider`, `implementerIdentity`, the A4b artifact-downgrade guard + `fileArtifactsMissing`, `fallback-report.ts`, the test-only `commit-stage.ts` / `task-completion-summary`, dead telemetry aggregation in `emitTaskTerminalHandler`, and the `reviewVerdict` / `reviewFindings` state mirrors — all zero-caller or superseded paths.

### BREAKING

- **`runTasks()` removed** (`packages/core/src/lifecycle`). It was a test-only public entry point; production and tests now go through `executeTask`. Any external caller of `runTasks()` must switch to `executeTask`.

## [4.7.13] - 2026-05-21

`tools/` component cleanup release — reduces `packages/core/src/tools/` and its coupled read-route stack to one design with one implementation per responsibility. Removes provably-dead modules, collapses the duplicated prompt and report/headline paths, wires the dormant `outputTargets` artifact check in delegate, reconciles execute-plan's two divergent input schemas to the live one, and renames the misleading `parallel-criteria-*` identifiers to `read-route-*` (the execution model is sequential criteria over one resumed session, not parallel fan-out). investigate's and research's distinct report parsers/headlines are kept — they are not duplicates. 2093 tests pass, build green, contract goldens unchanged.

### Added

- **`outputTargets` wired end-to-end in delegate** (`packages/core/src/tools/delegate/{schema,brief-slot,tool-config}.ts`). The post-task artifact check (`task-runner` → `implement-stage` → `file-artifact-check`) was fully built but delegate dropped the field before the `TaskSpec`, so it never ran. The field now flows input → brief → `TaskSpec`; a missing output target surfaces as a structured finding.
- **Shared read-route report/headline primitives** (`packages/core/src/reporting/findings-headline.ts`, `report-parser-slots/no-structured-report.ts`). `makeFindingsHeadlineTemplate(route, countLabel)` collapses the byte-identical audit/review/debug headline templates into one factory; `noStructuredReportSchema` is the shared throwing fallback slot (the annotator builds the canonical report).
- **`read_route_missing_target` assertion** (`packages/core/src/lifecycle/perform-implementation.ts`). A non-research read route that reaches dispatch with an empty target now throws before any session work, instead of silently falling back to `task.prompt`.
- **Subtype-enum ↔ `*_SUBTYPES` lockstep test** (`tests/tools/subtype-lockstep.test.ts`) — exact set-equality guard so a schema/route drift fails fast.

### Changed

- **Single read-route prompt path** (`packages/core/src/tools/{audit,review,debug,investigate,research}/tool-config.ts`). Each route sets `prompt` and `readTarget` to the same pure target; the worker prefix is built solely by the read-route dispatcher from `readTarget` + `FINDING_FORMAT_SHARED` + the route's `RouteSemantics` (`subtypes.ts`).
- **`execute-plan` has one input schema** — the live `executePlanInputSchema` (`tools/execute-plan/tool-config.ts`). The barrel re-exports it via a thin `barrel.ts`; the orphaned divergent `schema.ts` (object task form) is deleted.
- **delegate `agentType` defaulted in the Zod schema** (`.default('standard')`); the redundant `?? 'standard'` / `?? 'full'` fallbacks in `delegate/brief-slot.ts` are removed — the schema is the single defaulter.
- **`tools/index.ts` barrel** now exports exactly the seven output-envelope tools (delegate, audit, review, debug, executePlan, retry, investigate); `registerContextBlock` (no output envelope) is dropped.
- **Renamed `parallel-criteria-*` → `read-route-*`** (`tools/read-route-prompt.ts`, `lifecycle/read-route-criteria.ts`) and `TaskSpec.parallelTarget` → `readTarget`, matching the sequential execution model. No aliases.

### Removed

- **Dead modules** — `execute-plan/draft-id.ts`, `audit/plan-audit-verdict.ts`, and `lifecycle/plan-extraction.ts` (superseded by `execute-plan/plan-extractor.ts`), each with zero production callers, plus their tests.
- **Legacy prompt scaffolding** — the per-tool `FINDING_FORMAT_INSTRUCTIONS` / `buildPrompt` / `buildReviewPrompt` builders in audit/review/debug, the static `tools/shared/severity-ladder.ts` (`SEVERITY_LADDER`; severity is rendered route-specifically via `renderSeverityLadder`), and the orphaned `THOROUGHNESS_REMINDER_*` / `CONFIDENCE_REMINDER_INVESTIGATE` constants.
- **Dead per-tool reporting** — the fenced-JSON report parsers `report-parser-slots/{audit,review,retry}-report.ts` and the headline templates `headline-templates/{audit,review,debug,retry}.ts`, replaced by the shared factory + no-structured-report schema.
- **Dead single-pass research/investigate prompt builders** — research `compileResearchPrompt`/`compiledPrompt` and investigate `compiledPrompt` (the dispatcher uses `readTarget` / the two-turn pre-loop, never these), the unused `TwoTurnDeps.contextBlocks` param, and the now-dead investigate enriched-input fields `resolvedContextBlocks` / `relativeFilePathsForPrompt`.

## [4.7.12] - 2026-05-21

Transport-component cleanup release — reduces `packages/core/src/transport/` to one design with one implementation. `HTTPListener` becomes the sole HTTP listener (the server no longer creates `node:http` inline), the dormant `RouteDispatcher` response-shape metadata is removed, and the previously-unwired Host-header rebinding guard is now live. Bundles an independent set of type/config cleanups (config types derived from Zod, dead enums/types deleted) and a Windows console-flashing fix on git spawns. 2134 tests pass, build green, contract goldens unchanged.

### Added

- **Host-header rebinding guard wired into the request pipeline** (`packages/server/src/http/request-pipeline.ts`). Completes `LoopbackEnforcer`'s documented two-check defense: in addition to the IP-level loopback check, every request's `Host` header must be a literal loopback form (`localhost` / `127.0.0.1` / `[::1]`, with or without port). A foreign `Host` (DNS-rebinding attempt) is rejected with `403 forbidden_host`. The `isAllowedHostHeader` helper was previously exported but never called.

### Changed

- **`server.ts` uses `HTTPListener` instead of inline `node:http`** (`packages/server/src/http/server.ts`, `packages/core/src/transport/http-listener.ts`). The listener is now the single owner of the socket lifecycle; `RunningServer.stop` delegates to `listener.stop()`. Drain authority stays solely in `request-pipeline` (`setDraining`/`isDraining`).
- **Config types derived from the Zod schema** (`packages/core/src/types/config.ts`, `packages/core/src/config/schema.ts`). `MultiModelConfig`/`AgentConfig`/`ResearchConfig` are inferred from the schema rather than hand-mirrored; `RuntimeRunResult.stageStats` uses `Partial<StageStatsMap>` and `merge-stage-stats` imports the canonical `StageName`.

### Fixed

- **Swallowed async handler rejections now surface** (`packages/core/src/transport/http-listener.ts`). A rejected request-handler promise is logged to stderr and, when the response is still writable, answered with `500 internal_error` instead of being silently dropped (the latent bug existed in both the old `HTTPListener` stub and the inline `void handleRequest(...)` path).
- **`windowsHide` set on all git spawns** (`packages/core/src/lifecycle/`, `packages/core/src/reporting/commit-stage-runner.ts`, `packages/core/src/bounded-execution/progress-watchdog.ts`) to stop console-window flashing on Windows during commit/diff/toplevel operations.

### Removed

- **`RouteDispatcher` response-shape metadata** (`packages/core/src/transport/route-dispatcher.ts`). The `RouteMetadata` / `ResponseShape` types and the `metadata` parameter/field on `register`/`match`/`listRoutes` are deleted — they had no runtime consumer and had drifted from their docstring.
- **`HTTPListener` drain/start-time methods** — `beginDraining()`, `isDraining()`, and `getStartedAt()` removed; those responsibilities live in `request-pipeline` and `server.ts` respectively.
- **Dead type surfaces** — 15 unused closed enums (keeping `ReviewVerdictEnum` + `ConcernCategory`), the dead `draft-task.ts`, the unused `BriefQualityWarning`, and the `FallbackOverride` config type.

### BREAKING

- **Public type exports removed** — `RouteMetadata` and `ResponseShape` are no longer exported from `@zhixuan92/multi-model-agent-core`. `HTTPListener` no longer exposes `beginDraining`/`isDraining`/`getStartedAt`. Internal consumers in this repo are unaffected; external code depending on these would break (none expected — they had no in-repo callers).

## [4.7.11] - 2026-05-20

Structural cleanup release — dissolves the `tool-surface` component (two unrelated subsystems sharing one directory) into a runtime tool registry that stays in `core` and a skill-install lifecycle that moves to `server`. Removes the parallel OpenAPI route inventory (a second, hand-maintained tool list with no real consumer), deletes two dead code paths, and hardens the Gemini skill writer's include handling. Also bundles three independent fixes (codex spawn on Windows, stall-watchdog reset, dependency bump). Net −2000+ lines (mostly the deleted OpenAPI golden). No wire-schema changes. 2119 tests pass, build green.

### Changed

- **Skill-install lifecycle relocated from `core` to `server`** (`packages/core/src/tool-surface/` → `packages/server/src/skill-install/`). The 9 files `discover.ts`, `manifest.ts`, `skill-installer-common.ts`, `skill-manifest-sync.ts`, `include-utils.ts`, and the four `skill-installers/{claude-code,codex-cli,cursor,gemini-cli}.ts` move to where their only consumers live (`serve.ts`, `sync-skills.ts`, the `/health` drift bootstrap). The `skill-installer.ts` re-export barrel is deleted; consumers import the concrete modules directly. The `tool-surface/` directory now holds only the runtime registry (`tool-surface-registry.ts` + `register-all-tools.ts`).

### Fixed

- **Gemini skill writer's `@include` handling routed through the shared `include-utils.ts`** (`packages/server/src/skill-install/skill-installers/gemini-cli.ts`). It previously hand-rolled its own `inlineIncludes` that joined paths blindly with no `_shared/` prefix enforcement and no path-traversal guard, swallowing every read error as "file not found" — a path-traversal gap. It now uses the same hardened helper as Claude/Codex/Cursor (`_shared/` enforcement, traversal rejection, ENOENT-only suppression), covered by new security tests.
- **Codex detached-spawn guard scoped to POSIX** (`packages/core/src/providers/codex-cli-session.ts`) so Windows stdin works.
- **Stall-watchdog refreshes `lastEventAtMs` on provider progress events** (`packages/core/src/bounded-execution/`), preventing spurious idle-timeout aborts during long provider turns.

### Removed

- **Parallel OpenAPI route inventory deleted** (`packages/core/src/tool-surface/openapi-generator.ts`, `packages/server/src/http/handlers/introspection/tools-list.ts`, and the `GET /tools` + `GET /openapi` routes). The generator maintained a second hand-typed tool list parallel to the registry the server actually mounts from, with no internal runtime consumer (agents discover tools via installed `mma-*` SKILL.md files). Removed alongside its 3 tests, the 1,401-line `openapi.json` contract golden, and the `openapi-generator` package subpath export. **Anything fetching `GET /tools` or `GET /openapi` for API discovery now gets a 404.**
- **Dead `tool-surface/index.ts` barrel deleted** — re-exported siblings but was imported nowhere.
- **Dead `ManifestParseError` class deleted** (`manifest.ts`) — an exported error type that was never thrown (corrupt manifests self-heal by backing up + rebuilding empty).
- **9 `./tool-surface/*` subpath exports removed from `@zhixuan92/multi-model-agent-core`** `package.json` (the moved skill-install modules + the deleted openapi-generator). **BREAKING for any external consumer importing `@zhixuan92/multi-model-agent-core/tool-surface/{manifest,discover,skill-installer,…}`** — those modules now live in the server package.

### Dependencies

- **`claude-agent-sdk` upgraded to 0.3.145**; dropped the stale `@anthropic-ai/sdk` override.

## [4.7.10] - 2026-05-20

Cleanup release — two structural normalizations (review-component dissolution + stores normalization) plus a production web-fetch fix and a batch-progress correction. Net −2200 lines. No new features; no wire-schema changes (contract goldens unchanged except the architecture folder list). One latent production bug fixed: the research/explore SSRF connect-guard returned the wrong undici lookup shape and failed 100% of real fetches. 2122 tests pass, build green, zero skipped tests, zero `@deprecated` markers remain.

### Changed

- **Review prompts relocated to their lifecycle handlers** (`packages/core/src/lifecycle/handlers/`). `spec-review.ts` → `spec-review-prompt.ts`, `quality-review.ts` → `quality-review-prompt.ts`, plus `parse-review-report.ts` and `tier-policy.ts` moved out of the deleted `review/` directory to sit beside `review-stage.ts` (their sole caller). `rework.ts` → `rework-prompt.ts` beside `rework-stage.ts`; the `reworkTemplate` object collapsed to a plain `reworkPrompt(ctx)` function (the never-sent `systemPrompt` field was dead). `mapReviewVerdicts` moved to `packages/core/src/lifecycle/review-verdict-mapping.ts` beside `task-executor.ts`. Prompt output is byte-identical — pure relocation.
- **`SEVERITY_LADDER` extracted to `packages/core/src/tools/shared/severity-ladder.ts`** from the deleted `review/templates/finding-criteria.ts`; its three tool-config consumers (audit/debug/review) import from the new path.
- **In-memory context-block store is now unconditional** (`packages/core/src/stores/project-context-registry.ts`, `packages/server/src/http/project-registry.ts`). The storage-mode selection (disk vs memory) is gone.
- **`BatchRegistry.complete()` now releases context-block pins**, symmetric with `fail()` (`packages/core/src/stores/batch-registry.ts`) — pins are released on successful completion, not just on failure.
- **Batch-progress headline counts only stages that actually run.** The `[stageIndex/stageTotal]` display now shows the running stage's ordinal among non-skipped stages and uses the driver-published planned total as a stable denominator (`packages/core/src/events/task-envelope.ts`, `packages/core/src/lifecycle/lifecycle-driver.ts`). Read-only routes previously jumped `[1/2] → [5/5]` as skipped stages were recorded; they now show `[1/2] → [2/2]`.

### Fixed

- **Web-fetch SSRF connect-guard returned the wrong undici lookup shape** (`packages/core/src/research/web-fetch.ts`). undici invokes `connect.lookup` with `{ all: true }` and expects an array of `{ address, family }`; the guard called back with the single-result `dns.lookup` form, so undici read `addresses[0].address === undefined`, threw `ERR_INVALID_IP_ADDRESS`, and surfaced as `web_fetch_request_failed` — every production `webFetch` using the connect-guard agent failed at connect time. Invisible because the only test exercising the path was network-gated and off by default. Now forwards `opts` to `dns.lookup`, re-validates every resolved IP via the SSRF classifier, and returns the array form. Locked by three deterministic unit tests (`makeConnectGuardLookup`).
- **Retry batch terminalization** (`packages/server/src/http/handlers/tools/retry.ts`). Restored the `batchCache.complete`/`abort` calls so retry batches reach a terminal state correctly.

### Removed

- **`packages/core/src/review/` directory deleted entirely.** 12 dead files removed (the `quality-review-{audit,debug,investigate,review}` + `annotator-*` templates, the `index.ts` barrel, `review-types.ts`, `skipped-result.ts`); the live pieces relocated (see Changed).
- **`ToolConfig.reviewTemplates` property removed** (`packages/core/src/lifecycle/tool-config-types.ts`) — it was populated by six tool-configs but never read at runtime.
- **File-backed context-block store + disk-only `maxProjects` + serve startup sweep/migration removed** (`packages/core/src/stores/file-backed-context-block-store.ts`, `context-block-project-cap.ts`, `packages/server/src/cli/serve.ts`, `packages/server/src/migration/storage-migration.ts`). Context blocks are in-memory only; the `MMAGENT_CONTEXT_BLOCK_STORAGE` env switch and the `.mma/context-blocks/` on-disk persistence added in 4.7.x are gone. **BREAKING for anyone relying on disk-backed context-block persistence across daemon restarts.**
- **All `@deprecated` markers deleted.** Dead `PerTaskCostSlots` interface (zero importers — the live wire `costUSD`/`totalCostUSD` fields come from `terminal-handlers.ts` and are unchanged), dead `parseResearchReport` function, and dead `defaultIPPinningDispatcher` (the old broken IP-pinning dispatcher). Zero `@deprecated` markers remain in `packages/`.

## [4.7.9] - 2026-05-19

Research route rebuild + telemetry attribution fixes + read-route completion bug. `/research` is now a deterministic two-turn pipeline (turn-1 produces a `QueryPlan`; turn-2 reasons over a pre-built `EvidencePack`) with `tools: 'none'` on the worker — workers never call native `WebSearch`/`WebFetch`. Adapters degrade cleanly when API keys are missing (Semantic Scholar skipped without key; GitHub search drops `kind=code` without PAT). Telemetry per-stage `model` field now records the actual reviewer/annotator model instead of the implementer's, non-LLM stages (committing, skipped stages) are filtered out of the wire `stages` array, and the reviewer parser's `approved → changes_required` override is severity-gated (only flips for `critical`/`high` findings). Pre-existing read-route completion bug fixed: every successful investigate/research/audit/debug/review used to seal as `terminal_status=error, worker_status=failed` because `criteriaSucceeded` was never populated on `lastRunResult`. 2159 tests pass, build green.

### Added

- **Research two-turn driver** (`packages/core/src/tools/research/two-turn-driver.ts`). Turn 1 emits a `QueryPlan` (Zod schema in `packages/core/src/research/query-plan-schema.ts`); turn 2 synthesises against the orchestrator-produced `EvidencePack`. Runner-agnostic — driver consumes only `Session.send` returning `TurnResult.output`, same shape on Claude and Codex.
- **Deterministic Step-2 fan-out orchestrator** (`packages/core/src/research/orchestrator.ts`). Parallel fan-out over Brave + Arxiv + Semantic Scholar + GitHub Search + RSS adapters with timeouts, host allowlist, and an explicit query budget.
- **`EvidencePack` types + dedup + budget enforcement** (`packages/core/src/research/evidence-pack.ts`).
- **Adapter credentials block in config** (`packages/core/src/config/schema.ts:research.builtinAdapters.*` + `creds`) and `resolveEnabledAdapters(cfg, creds)` that silently skips Semantic Scholar when no API key.
- **GitHub Search PAT support** (`packages/core/src/research/adapters/github-search.ts`). `kind: 'code'` queries gracefully degrade to issue/PR search when no PAT is configured.
- **SSRF guard via connect-callback** (`packages/core/src/research/http-fetch.ts`). Replaces the broken IP-pinning dispatcher; preserves the host allowlist contract.
- **User-Agent helper** (`packages/core/src/research/user-agent.ts`). Stamps `mma-research/<semver>` on every outbound HTTP request from research adapters.
- **`runResearchPreLoop` in `perform-implementation`** — runs the turn-1 plan + orchestrator before the read-route N-criterion loop, attaches the resulting `EvidencePack` as the cached prefix so the 5 criterion turns synthesise against shared evidence.
- **20+ acceptance tests** (`tests/research/acceptance/`) covering runner matrix, closed pipeline, budget enforcement, retry behaviour, adapter degradation, schema validation.
- **`HostString` validator on `research.userSources`** — Zod-side check that operator-configured user sources are bare hostnames (not URLs).

### Changed

- **Per-stage `model` attribution** (`packages/core/src/events/to-wire-record.ts`, `packages/core/src/lifecycle/handlers/review-stage.ts`, `packages/core/src/lifecycle/handlers/annotate-stage.ts`). The reviewer stage previously hardcoded `model: null` on its `reviewerResult`, so the lifecycle driver's fallback stamped the implementer's model into the wire row — every inverted-tier review reported the wrong reviewer model. Annotate had the symmetric bug via `(r as any).model` reading a field that doesn't exist on `TurnResult`. Both stages now look up `ctx.providers[tier].config.model`, the same pattern rework-stage and `perform-implementation` already use.
- **Non-LLM stages filtered from wire `stages` array** (`packages/core/src/events/to-wire-record.ts`). Drops stages with zero tokens + zero/null cost: `committing` always, skipped `review`/`rework`/`annotate` too. The in-memory envelope still carries every stage row; strip happens at wire serialization only. The `tierUsage` rollup applies the same filter so a zero-cost stage doesn't seed `bucket.model` from a stage that did no LLM work.
- **Reviewer parser severity gate** (`packages/core/src/review/parse-review-report.ts`). The `approved + findings.length > 0 → changes_required` override is now gated to findings with severity in `critical`/`high`. A cooperative LLM that approves and lists only low/medium nice-to-fix nits keeps its approval; the engine still catches contradictions where a blocker finding is paired with `approved`.
- **Worker UAs on Brave + Arxiv** (`packages/core/src/research/adapters/arxiv.ts`, `packages/core/src/research/brave-client.ts`).

### Fixed

- **`criteriaSucceeded` never populated on read-route `lastRunResult`** (`packages/core/src/lifecycle/perform-implementation.ts`). `deriveCompletion` for read-routes requires `criteriaSucceeded.length > 0` to consider a task completed; without this every successful investigate/research/audit/debug/review sealed as `worker_status=failed, terminal_status=error` despite producing real findings. Bug predated 4.7.9 (same code path in v4.7.8) but landed via the smoke harness. Fix populates `criteriaSucceeded` from `routeSpec.criteria` minus errored ids.
- **Research worker no longer references native `WebSearch`/`WebFetch`** in prompts (`packages/core/src/tools/research/brief-slot.ts`, `packages/core/src/tools/research/implementer-criteria.ts`). Worker has `tools: 'none'`; criteria prose now references "whatever tool you have for this source" instead of naming tools the worker can't call.
- **Two-turn driver JSON repair** (`packages/core/src/tools/research/two-turn-driver.ts`). When the first turn returns unparseable JSON, the retry's successful turn result is returned as `turn1Result` so downstream callers see the recovered output.
- **Backfilled 553 historical wire rows** in production telemetry DB (`mma_telemetry.events_raw`) — stripped the `committing` entry from `event.stages` JSONB on rows where it existed, since post-4.7.9 wire output never includes it. Rows where stripping would have produced an empty stages array (R2.1 invariant) were left untouched (0 such rows). `recovered_at` timestamp set on each updated row.

### Removed

- **Dormant `customToolset` slot + `ResearchToolDefinition` type** (`packages/core/src/tools/research/`). 9-file substrate that was created but never wired into the lifecycle. Grep zero-hit confirmed.

### Notes

- **Worker `tools` setting for `/research` is locked to `'none'`** — the worker reasons over the pre-built `EvidencePack`; only the orchestrator hits external services. This is enforced at the tool-config level (`packages/core/src/tools/research/tool-config.ts`), not configurable per request.
- **Adapter degradation is silent by design** — missing Semantic Scholar key or GitHub PAT does not fail the request; the orchestrator simply skips that source. Caller can detect via the `EvidencePack` `failedAttempts` list.
- **`SCHEMA_VERSION` stays at 5** — same back-compat reasoning as 4.7.7/4.7.8 (bumping drops queued v5 records via `flusher.ts:143`). Wire shape unchanged.

## [4.7.8] - 2026-05-19

Deterministic completion gate. The completion judgment that produces wire `terminal_status` / `worker_status` / `error_code` is now derived from objective lifecycle signals (review verdict, commit gate payload, rework state, implement outcome, criteria success) instead of worker self-assessment. Worker self-assessment is recorded in telemetry but no longer gates completion. Closes the bug class where 68% of worker structured outputs reported `completed: false` on 2026-05-18 despite the underlying work succeeding (analysis: review-approved + commit-landed but seal-gate downgraded). Schema version stays at 5.

### Added

- **`deriveCompletion(state)` pure function** (`packages/core/src/lifecycle/derive-completion.ts`). Single source of truth used by the annotator gate and the envelope seal. Inputs: `implementOutcome`, `reviewPolicy`, `reviewVerdict`, `reworkApplied`, `reworkError`, `unaddressedFindingIds`, `commitKind`, `autoCommit`, `route`, `criteriaSucceeded`. Worker self-assessment is intentionally not a parameter.
- **`tests/contract/wire-record-blast-radius.test.ts`** — regression guard asserting only 5 named status fields may differ between pre/post change for a fixed fixture. All cost/token/timing/identity/counter/stage fields unchanged.

### Changed

- **Annotator gate** (`packages/core/src/lifecycle/annotate-parser.ts`). `applyAnnotatePreconditions` now delegates to `deriveCompletion()`. Removed the hard `workerSelfAssessment !== 'done'` blocks at lines 37-39 (read) and 48-50 (write). Reads commit state from `state.gates.commit?.payload?.kind`, not the legacy `state.commits[]` mirror.
- **Envelope seal** (`packages/core/src/lifecycle/handlers/terminal-handlers.ts`). `envelope.status` derived from `deriveCompletion()`. `done_with_concerns` preserved as side branch when `env.findings` non-empty.
- **`enrich-runtime-result.ts`**. Removed the `enriched.workerStatus = 'failed'` line added in 4.7.7 Task 3 — no longer needed since the seal uses `deriveCompletion()` directly. The `errorCode` mapping for review-rejection stays (still useful for the new gate).
- **Annotator prompt builder** (`packages/core/src/lifecycle/annotate-prompts.ts`). Serializes `committed` from `state.gates.commit?.payload?.kind === 'committed'`. Prompt prose rewritten to describe the new gate semantics; worker self-assessment is informational only.
- **Worker prompts.** `tools/execute-plan/implementer-criteria.ts` Self-verification block rewritten: "report what you completed; environment limitations go in `summary`; mark 'done' if code changes are complete; the system independently verifies." `tools/delegate/implementer-criteria.ts` gains the same explicit guidance. `review/templates/rework.ts` adds "verification is the reviewer's responsibility — do not mark yourself failed because you couldn't independently verify."

### Fixed

- **47% of false-negative telemetry rows (commit-plumbing bucket).** Annotator now reads the active commit gate (`state.gates.commit?.payload?.kind`) instead of the unmaintained legacy `state.commits[]` mirror. Workers' real `git commit` SHAs are now visible to the gate.
- **26% of false-negative telemetry rows (worker self-assess misreport).** Worker `'failed'` self-assessment no longer overrides objective signals. When review approves and the commit lands, the wire record is `terminal_status='ok'` regardless of what the worker reported.
- **Backfilled 72 historical false-negative rows** in the production telemetry DB (`mma_telemetry.events_raw`) via a one-shot `deriveCompletion()`-based re-derivation. Updated rows now carry `terminal_status='ok'` + `worker_status='done'`/`done_with_concerns` + `error_code=NULL` + `recovered_at` timestamp. The script that performed the backfill was removed from the codebase after the apply succeeded (one-shot tooling).

### Notes

- **`SCHEMA_VERSION` stays at 5.** Same reason as 4.7.7 — `flusher.ts:143` drops queued v5 records on bump. Field semantics change; shape unchanged.
- **Backend ingester column `recovered_at`** was added once during the historical-row backfill and is now part of the live schema. Future runs of the live ingester ignore it.
- **Worker self-assessment is still emitted in the wire record** for telemetry analytics ("how often do workers correctly self-report?") but does not affect completion gating.

## [4.7.7] - 2026-05-18

Wire-record honesty pass + complete `verifyCommand` feature removal. The wire telemetry now distinguishes per-task `reviewPolicy` intent from the actual stage outcome, and `errorCode` is preserved through the seal path so reviewer rejection lands a non-null code (`review_quality_findings_unresolved` or `review_spec_rejected_terminal`) instead of being indistinguishable from transport failure. Schema version stays at 5 (bumping would silently drop queued v5 records via `flusher.ts:143`). Full suite 2064/2064 passing.

### Removed

- **`verifyCommand` feature end-to-end.** Removed from the delegate + execute-plan Zod request schemas (callers passing the field now get `400 invalid_request` via Zod `.strict()`), `TaskSpec`, `DraftTask`, both brief slots, delegate `implementer-criteria` worker prompts (4 mentions), rework-stage prompt + header comment, the dead `VerifyStageRunner` reporting module, the `validateVerifyCommand` server-side allowlist validator and its 2 handler call sites in `delegate.ts`/`execute-plan.ts`, the `verifyOutcome` field in `stage-plan-types`/`stage-stats`, the `validator_verify_command_failed` member of `ErrorCodeSchema`, the `verifyCommandPresent` wire field (schema + projector + lifecycle slots in `stage-plan-types`/`task-runner`/`lifecycle-context` + server `buildOpts` defaults), and the inert `validationsRun` byproduct field (parser + lifecycle handlers + fallback report + batch handler + fixtures). Skill docs (`mma-delegate/SKILL.md`, `mma-execute-plan/SKILL.md`) drop the `verifyCommand` row and the "Skipping verifyCommand" pitfall; the shared snippet `_shared/verify-and-review.md` was renamed to `review-policy.md` with the verify half stripped. OpenAPI + endpoint goldens regenerated. The dedicated tests `tests/tool-schemas/verify-command.test.ts` and `tests/reporting/verify-stage-runner.test.ts` were deleted; row 8 of the terminal-status truth table (`verifyOutcome=failed → validator_verify_command_failed`) was dropped along with the matching deriver case.
- **Server-side default `reviewPolicy: 'full'` constant in `TelemetryUploader.buildOpts`.** Both `server.ts` uploader registrations no longer supply `reviewPolicy`; the value now comes from `TaskEnvelope.reviewPolicy`, populated at envelope construction from per-task `state.reviewPolicy`. The wire `review_policy` column is now the per-task intent — not a server default — and is complementary to `stages.review.outcome`, which describes what actually ran. An intent=`full` + outcome=`skipped` row (e.g. implement stage failed, read route, review-skip gate triggered) is now a legitimate and queryable signal rather than the apparent contradiction it used to be.
- **Server-side `verifyCommandPresent: false` constant in `buildOpts`.** Field gone from the wire schema; backend DB column is nullable and continues to receive null for new records.

### Fixed

- **`error_code` was null on reviewer rejection.** `recordTaskCompletedHandler` (`terminal-handlers.ts:202`) now copies `runtime.errorCode` onto the sealed envelope alongside `structuredError`. Reviewer-rejected paths land `review_quality_findings_unresolved` (quality review verdict=`changes_required`) or `review_spec_rejected_terminal` (spec review verdict=`changes_required`) in the wire `errorCode` column. Previously `terminal_status=error + error_code=null` was indistinguishable from a transport/runtime failure.
- **`enrich-runtime-result.ts` no longer emits the invalid `'review_rejected'` errorCode value.** `'review_rejected'` was never a member of `ErrorCodeSchema`; the bug was masked because the seal path dropped `errorCode` anyway. Now `enrich-runtime-result` inspects `state.reviewSubResults` and emits the right canonical code based on which sub-result returned `changes_required`. As part of the fix, `enrich-runtime-result` also sets `enriched.workerStatus = 'failed'` on the review-rejected branch, so the seal handler maps to envelope `status='failed'` → wire `terminalStatus='error'` (without this the workerStatus stayed at the earlier `'done'` default and the wire emitted `terminalStatus='ok'` alongside the new `errorCode`, violating the R1 invariant).
- **Per-task `reviewPolicy` on `/delegate` was silently overwritten with the route default on the wire.** Caught by release smoke after the earlier honesty pass landed. `async-dispatch.ts` creates task 0's envelope with `reviewPolicy: 'full'` before per-task TaskSpecs exist, then `lifecycle-dispatcher.ts:83` reads `rawRequest.reviewPolicy` from the top level — but `/delegate`'s schema nests `reviewPolicy` inside each `tasks[i]`, so the read returned undefined and the envelope's `reviewPolicy` stayed at the route default. `prepare-execution-context-handler.ts` corrected `state.reviewPolicy` from the per-task value for lifecycle gating (review actually did skip when policy was `none`) but never touched the envelope, so the wire still reported `reviewPolicy: 'full'`. Fix: new `TaskEnvelopeStore.setReviewPolicy()` mutator + `task-executor.ts` calls it on task 0's envelope and seeds tasks 1+'s envelopes from `tasks[i].reviewPolicy` directly, so the wire field now matches the caller's intent on the full /delegate fan-out. New `tests/lifecycle/per-task-review-policy-envelope.test.ts` pins all four enum values across single- and multi-task batches plus the mutator's seal-guard.

### Added

- **`TaskEnvelope.reviewPolicy` (required) and `TaskEnvelope.errorCode` (optional).** `reviewPolicy` enum matches `delegate/schema.ts` / `execute-plan/schema.ts`: `'full' | 'quality_only' | 'diff_only' | 'none'`. `TaskEnvelopeStore.create()` throws if the seed omits `reviewPolicy` — a silent default would re-introduce the dishonesty bug. `seal()` preserves `errorCode` from the runtime result.
- **Wire-schema docstring invariants.** `wire-schema.ts` now documents that `reviewPolicy` is per-task intent (not outcome) and that `errorCode` is non-null whenever `terminalStatus === 'error'`. New `tests/contract/wire-schema-version.test.ts` pins `SCHEMA_VERSION === 5` so an accidental bump can't slip into a routine field removal again. New `errorCode invariant` describe block in `tests/contract/observability/event-manifest.test.ts` (sentinel; real end-to-end coverage in the integration test below).
- **`tests/integration/review-rejection-error-code-pipeline.test.ts`.** Two end-to-end cases — quality and spec rejection — drive `enrichRuntimeResult` + `recordTaskCompletedHandler` and assert the wire record has `terminalStatus='error'`, `workerStatus='failed'`, and the matching `errorCode`. Closes the original bug.
- **`tests/tool-schemas/strict-unknown-keys.test.ts`.** Regression guard: any request that sends `verifyCommand` to `/delegate` or `/execute-plan` is rejected with `400 invalid_request`. Pins the `.strict()` precondition explicitly so a future schema refactor can't silently accept the removed field again.
- **`tests/events/to-wire-record-review-policy.test.ts` and `to-wire-record-error-code.test.ts`.** Unit-level coverage for the new envelope-resident `reviewPolicy` and `errorCode` projection.

### Notes

- **`SCHEMA_VERSION` stays at 5.** Bumping would drop queued v5 records via `flusher.ts:143`. The wire shape change is intentional and unversioned per the greenfield rule in `.claude/rules/development-mode.md`.
- Backend ingester column `verify_command_present` is already nullable and continues to accept null for new records. No backend migration required.

## [4.7.6] - 2026-05-18

Providers/runtime-spine refactor + correctness fixes for multi-task `/delegate`, codex file-write attestation, wire/log divergence on failed batches, and the always-`null` `mainCostUSD` regression introduced by the 4.7.2 envelope rewrite. 48 commits since 4.7.5; full suite 2055/2055 passing. Three structural cuts: (1) the `providers/` directory dropped from 19 files to 12 — every retained file has live callers, no wrappers, no dead enum members; (2) `TurnResult` narrowed from 14 fields to exactly 9; (3) wrapper layers around the per-tier SDK calls (`run-reviewer.ts`, `run-annotator-turn.ts`, `run-worker-turn.ts`, `stall-detector.ts`, etc.) deleted in favor of direct `session.send` and inline tier policy.

### Added

- **Per-session `ANTHROPIC_*` env isolation (core).** `claude-session.ts` now injects `apiKey` / `baseUrl` / oauth token via the Claude SDK's `Options.env` on each `query()` call, instead of relying on shared `process.env`. Two concurrent dispatches with different `apiKey` headers can no longer step on each other or leak credentials into the parent process env. A3.2 / A3.3 contract tests assert this.
- **Per-task session safety ceiling (core).** `provider-factory.ts` tracks live sessions in `liveByTask: Map<{batchId,taskIndex}, Map<sessionId, Session>>` with a per-key cap of 2 (one standard + one complex) and a 100-session global ceiling. `releaseTask(batchId, taskIndex)` is called from `task-runner.ts`'s finally block; any sessions still tracked under that key are force-closed and the map entry cleared. A6.1–A6.6 cases lock in the behavior, including `releaseTask` continuing the close loop when one inner `close()` throws.
- **`mma-research` skill is now installable.** Previously the SKILL.md was packaged but missing from `SUPPORTED_SKILLS`, so `mmagent sync-skills` skipped it on every client. Added to the list; 11 skills now install instead of 10. Main agents can read the skill via the Skill tool instead of having to fetch the npm-bundled file directly.
- **Per-task envelopes for multi-task `/delegate` (core, server).** When `tasks.length > 1`, `task-executor.ts` now creates one `TaskEnvelopeStore` per task and attaches each to the batch registry. Pre-fix, only one envelope (`taskIndex=0`) was created by `async-dispatch.ts`; tasks 1+ shared it, so when task 0 sealed first the next task's `recordToolCall` raised `SealedEnvelopeError` and crashed the batch. Tasks 1+ now get distinct envelopes with `taskId = ${batchId}:${i}`; `tasksTotal` / `tasksStarted` bump from the placeholder of 1 to the real fan-out width. New `tests/lifecycle/multi-task-envelope-attach.test.ts` covers single-task (no behavior change), 3-task envelope distinctness, and independent seal semantics.
- **Codex CLI 0.130 `file_change` item shape supported (core).** `CodexItem` now accepts both the modern `changes: [{ path, kind: 'add'|'modify'|'delete' }]` shape (codex 0.130.0+) and the legacy flat `path` field. `codex-cli-session.ts`'s `file_change` branch collects paths from both shapes and records a single `recordToolCall({tool:'edit_file', filesWritten: paths})`. Pre-fix, codex tasks under `gpt-5.4` reported `filesChangedCount=0` even when files were actually written to disk; reviewer then halted on "no files changed."

### Changed

- **`TurnResult` narrowed to exactly 9 fields (core).** From 14 fields (output, usage, costUSD, turns, durationMs, terminationReason, errorCode, filesWritten, usedShell, filesRead, toolCalls, toolCallsByName, workerSelfAssessment, …) down to the 9 fields downstream consumers actually use. `terminationReason` enum narrowed from 11 members to 6 (`'ok' | 'error' | 'time_exceeded' | 'cap_exhausted' | 'stalled' | 'aborted'`); the dropped members (`'rate_limit' | 'overload' | 'transport' | 'truncated' | 'json_parse_failed'`) had no producers. New shape-assertion test (`tests/providers/turn-result-shape.test.ts`) prevents the field set from re-expanding.
- **Pending-batch headline format (server).** `/batch/:id` 202 body changed from `, N read, M write, K tool calls` to `, M write, K tool calls`. The `N read` clause was always `0` since the producer-side `toolReads` / `filesRead` slots were never populated (no producer ever wrote to them); reporting an always-zero counter was misleading. The slot itself is removed from `TaskEnvelope`, `ToolCallRecord`, `HeadlineSnapshot`, and `RunningTaskProgress`.
- **`filesChangedCount` falls back to `filesWritten` for non-git cwds (server).** Previously derived only from `env.realFilesChanged.length`, which uses `git diff` and returns `[]` for non-git working directories (e.g. `/tmp`). Codex tasks that wrote real files under such cwds reported `filesChangedCount=0`. Now falls back to `env.filesWritten.length` when the git-diff signal is empty but the per-task tool-call signal is non-empty. Same fallback applied to the rollup `structuredReport.filesChanged`.
- **Wire field rename: `mainEquivalentCostUSD` → `mainCostUSD` (core).** Aligns the wire field name with the DB column `main_cost_usd`, consistent with the v4.0.3 "internal === wire" principle. Same semantic ("what the SAME tokens would have cost at the main model's rate"). `costDeltaVsMainUSD` unchanged. Backend dual-accepts both names during the daemon-restart transition; the old name will be removed in a future release once all live daemons are confirmed restarted. PRIVACY.md + the privacy-doc-sync contract test updated in lockstep.
- **OPENAI_API_KEY default applied consistently in codex env (core).** `codex-cli-launch.ts` now uses `cfg.apiKeyEnv ?? 'OPENAI_API_KEY'` in both the `env_key` provider config line and the env-key assignment; previously the default was applied in one place but not the other.

### Fixed

- **Per-stage and top-level `mainCostUSD` + `costDeltaVsMainUSD` are computed again (core).** Every audit / review / debug / investigate event in the v4.7.2–v4.7.5 window landed at the warehouse with `main_cost_usd = NULL`, collapsing per-model savings attribution on the Lite dashboard by ~17% for the affected window (one observed case: haiku savings showed as $304 instead of ~$335 because 209 of 1,254 haiku stages contributed $0). Root cause: the 4.7.2 envelope-unification refactor (`a1ec2177`) deleted `event-builder.ts` and replaced it with `to-wire-record.ts`, but never ported the 15-line compute block from `e9d42fbb` (4.5.0) that resolves the main model's rate card and prices each stage's tokens against it. `to-wire-record.ts` now resolves the main rate card once via `resolveRateCard(env.mainModel)` and runs `priceTokens(stageTokens, mainCard)` per stage and over the totals at top-level. When `mainModel` is unknown to the profile registry, both fields stay null at every level (honest-null discipline). Five new test assertions in `tests/events/to-wire-record.test.ts` lock in the populated values, the per-stage-sum invariant, and the null-when-unknown behavior.
- **Wire `error` field reflects detected failures (server).** `async-dispatch.ts` called `batchRegistry.complete()` unconditionally BEFORE `detectFailure()`. Since `complete()` makes the state terminal, the subsequent `fail()` call was a no-op. `/batch/:id` then read `state='complete'` and returned `error: {kind:"not_applicable", reason:"batch succeeded"}` even when `detectFailure` had identified a real failure (Probe I: 3-task `/delegate` that crashed mid-execution). Reordered: detect failure FIRST, then call `complete()` or `fail()` exactly once.
- **`implementHandler` reads `workerSelfAssessment` from the parsed worker output (core).** Pre-fix, `result.workerStatus` was the only source — but that field is populated by `enrichRuntimeResult`, which runs AFTER `implement-stage`. Standard write tasks therefore always reported `workerSelfAssessment='failed'` regardless of what the worker emitted. Extended the lookup chain to fall back to `parseWorkerOutput(result.output).workerSelfAssessment` before defaulting. Re-enables the previously-failing `implement-stage.test.ts > returns a StageGate<ImplementPayload> on advance` case.
- **Headline format reflects real activity signals (server).** `compose-running-headline.ts` switched from `reads=N writes=M tools=K` to `M files written, K turns` for active tasks; the always-zero `reads=` clause is gone, and `turns` (which IS observed via runner events) replaces the unobservable `reads` counter.

### Removed

- **`providers/run-worker-turn.ts`, `providers/run-annotator-turn.ts`, `review/run-reviewer.ts` wrappers (core).** Each was a thin shim around `session.send` that added retry boilerplate the SDK already handles. Removed; review and annotate stages now call `session.send` directly. `review/tier-policy.ts` extracted the one piece of cross-tier inversion logic (`invertedReviewerTier`) that the wrappers actually needed.
- **`providers/stall-detector.ts`, `providers/runner-adapter.ts`, `providers/brief-preamble.ts`, `providers/error-classification.ts`, `providers/tool-name-sets.ts`, `providers/index.ts` (core).** All dead — no live callers in the codebase. `claude-tool-categories.ts` is the new single source of truth for Claude write/shell tool classification; `tests/helpers/test-harness.ts` holds the `RunnerAdapter` test-bridge type.
- **`run-tasks/tier-policy-registry.ts`, `cost/cost-rollup.ts` (core).** Dormant since the 4.0.x architecture cutover; deleted as part of the same audit pass.
- **Dead `filesRead` / `toolCalls` / `toolCallCount` / `filesReadCount` / `toolReads` plumbing (core, server).** Producer side was removed by the migration; the typed storage slots (`TaskEnvelope.filesRead`, `ToolCallRecord.filesRead`, `HeadlineSnapshot.toolReads`, `RunningTaskProgress.toolReads`, `StageStatsShape.toolCallCount` / `filesReadCount`) were always empty/zero but the headline composer still rendered them. Slots removed end-to-end; net –32 LOC of dead plumbing.

### Telemetry & ingest notes

- Backend ingest accepts both `mainEquivalentCostUSD` and `mainCostUSD` during the daemon-restart transition window. Daemons running 4.7.6+ emit `mainCostUSD`; older daemons emit `mainEquivalentCostUSD`. Once all live daemons are confirmed restarted, the old name will be removed in a future release.
- `findingsBySeverity`, `findingsOutcome`, `findingsOutcomeReason`, `outcomeInferred`, `outcomeMalformed` (added in 4.7.4) continue to flow through `envelopeToPublicResult` and `to-wire-record` unchanged.

## [4.7.5] - 2026-05-18

Polling-headline truthfulness pass. The pre-4.7.5 polling output (`[N/M] stage — reads=0 writes=0 tools=K`) showed `reads=0 writes=0` for the entire task lifetime because Claude's tool_use blocks always recorded empty file arrays — making it look like no file activity was happening even when the worker was actively running Read/Write/Edit tools. Two fixes ship together so the headline becomes truthful.

**Principle: only record file paths we can directly observe.** Tool-name heuristics and shell pattern matching are not used; if we don't know the actual file from the provider's structured event, we don't count it. The adaptive headline below hides what we can't see, so the counters are always honest.

### Added

- **Claude file-path extraction (core).** `claude-session` now extracts `file_path` (or `notebook_path`) from each tool_use block's input and records it through `envelope.recordToolCall`. `Read` contributes to `filesRead`; `Write` / `Edit` / `MultiEdit` contribute to `filesWritten`; `NotebookEdit` contributes to both (reads-then-writes). `Bash`, `Glob`, `Grep`, `WebFetch`, and similar tools record the call but no file activity — `Glob` returns a pattern not a file; `Grep` doesn't tell us which matching files the agent actually consumed.

### Changed

- **Adaptive polling-headline stats (server).** `/batch/:id` 202 body now shows `tools=N` always (the most reliable activity signal across all providers) and appends `reads=N` / `writes=N` only when each is > 0. Previously the literal `reads=0 writes=0` rendered through the entire lifetime of most tasks; now those tokens only appear when there's real file activity to report. Codex shell-reads (`cat` / `nl` / `sed` / etc.) remain intentionally untracked — codex CLI does not emit a `file_read` event, and shell-parsing heuristics would create false positives.

### Fixed

- **Investigate retry-path findings extraction (core).** Finished the half-shipped 4.7.4 findings canonicalization. The investigate `brief-slot.ts` still mandated the legacy `## Summary / ## Citations / ## Confidence` shape; only the read-route-implementer's `parallel-criteria-prompt` had been canonicalized to `## Finding N:` blocks. Direct `/investigate` calls worked (they route through the read-route branch), but `/retry` of an investigate task — which routes through the standard implementer path because retry's `toolCategory='assist'` — used the original task's prompt verbatim, so the worker emitted `## Summary`-led prose and the parser silently dropped every Finding. End result: `results[N].findings = []` and the DB's `findings_critical/high/medium/low` columns stayed at 0 regardless of how much investigation work the worker did (one observed case: 20K output tokens / 64 tool calls / $1.04 spent → 0 findings recorded). The investigate brief-slot now mandates `## Finding N:` blocks alongside the kept `## Summary` and `## Confidence` sections, and `perform-implementation.ts` parses canonical Findings on the standard-implementer path so the bridge from `payload.findings` → `envelope.findings` fires for retry too.
- **Findings-parser dropped-block visibility (core).** `parseFindings` has had a `warnSink` callback since 4.7.4 to surface dropped/malformed Finding blocks (empty claim, missing severity, invalid evidence format, missing file:line on investigate routes). All three production callers (`read-route-implementer`, `parse-review-report`, the new standard-path parser) passed `() => {}` so the warnings vanished. They now route into `envelope.validationWarnings` (already on the wire), making the silent-drop class visible in the verbose log and per-task telemetry — operators can see when a 19K-character worker output produced 0 findings because of format drift, rather than guessing.

## [4.7.4] - 2026-05-18

End-to-end findings coherence release. Read-route workers (investigate / audit / debug / research) now contribute their actual findings to the wire, the HTTP per-task result, and downstream telemetry — previously dropped silently. Findings-summary signals are now emitted at one canonical place (the top level of the wire event + per-task HTTP result), with per-stage rows reserved for stage mechanics only. Backend telemetry ingest, dashboard severity tiles, and the daemon's local HTTP responses all read from the same source of truth.

### Added

- **Tolerant findings parser (core).** Accepts `## Finding N:`, `### Finding N`, `## Issue N:`, `## Concern N:`, optional `**bold**` wrapping, and `:`/`./`)` terminators. Bullet matcher accepts `-` or `*` and `**Severity:**` bold-bullet style. `## Outcome` extractor accepts canonical, inline (`## Outcome: found`), and headless (`Outcome: found`) forms. LLM-emitted heading drift no longer silently drops findings.
- **`envelope.recordFinding` bridge (core).** `composeHandler` now pushes `payload.findings` onto `envelope.findings` (normalizing required envelope fields: `id`, `evidence`, `source`). Previously the API was defined but had no producer — every `results[N].findings` was `[]` regardless of what the worker emitted.
- **Top-level findings rollup on wire + HTTP (core / server).** `TaskCompletedEventSchema` and `envelopeToPublicResult` now expose `findingsBySeverity`, `findingsOutcome`, `findingsOutcomeReason`, `outcomeInferred`, `outcomeMalformed` at the top level. Backend ingest reads from one place; frontend severity tile remains unchanged.
- **`findingsOutcome` threading for read routes (core).** `mergeStageStats` propagates the outcome quartet through `implementing` and `annotating` stages (was previously `review`-only). `perform-implementation` passes the worker-emitted outcome from the read-route dispatcher.

### Changed

- **Per-stage wire rows no longer carry `findingsBySeverity` / `findingsOutcome` / `findingsOutcomeReason` / `outcomeInferred` / `outcomeMalformed`.** These fields lived on review, implementing, and annotating rows under 4.7.3 — three sources for the same data, with backend extractors re-implementing aggregation. They are now top-level only. Backend transformer prefers top-level; falls back to per-stage review rollup for pre-4.7.4 events (back-compat).
- **Investigate evidence-format check loosened (core).** Findings whose `Evidence` line contains `file:line` anywhere (not just at the start) are now accepted. Workers naturally write `In [src/foo.ts:42] …` or wrap citations in markdown links; both forms now pass.
- **Legal-outcome guard in parser (core).** When a worker declares an outcome that isn't legal for the route (e.g. `not_applicable` on an issue-hunting criterion), the parser falls back to the inferred outcome rather than passing illegal values downstream.
- **Batch-level `structuredReport.findingsOutcome` (server).** `/batch/:id` response now exposes a rollup outcome aggregated across all snapshots' stages (any `found` → `found`; else any `not_applicable` → `not_applicable`; else `clean`; `null` if no stage emitted one).

### Fixed

- **`results[N].findings` returned `[]` for every read-route batch (core).** Worker findings were parsed correctly but never reached `envelope.findings` because `recordFinding` had no caller. Fixed by the compose-handler bridge above.
- **`stages[implementing].findingsOutcome` always `null` on read routes (core).** Even when the worker explicitly declared `## Outcome\nfound`, the value never made it into the wire stage row. Fixed by extending `mergeStageStats` to thread `findingsOutcome` for `implementing` and `annotating` stages.

## [4.7.3] - 2026-05-17

Fix-forward release closing the envelope-pipeline regressions introduced by 4.7.2's events/lifecycle rewrite, plus the long-standing aggregation gaps the same data-flow audit surfaced. Every public HTTP route + skill + CLI command behaves the same; observability (polling headline, stderr stream, telemetry queue) is now end-to-end correct.

### Fixed

- **Polling headline stays stuck at `[0/0] queued` for the entire task (core).** `task-executor.runTaskViaDispatcher` dropped `envelope` from the per-task `ExecutionContext`, so `envelope.startStage` / `recordToolCall` / `seal` all silently no-op'd. Stages array never populated; the `/batch/:id` 202 body kept showing `[0/0] queued` while the worker was actively executing.
- **Provider sessions never call `envelope.recordToolCall` (core).** `task-runner.openSession` dropped `envelope` from `SessionOpts`, so `codex-cli-session` + `claude-session`'s `envelopeOf(opts)` returned undefined. Same root pattern as the executor bug above.
- **Read-route tasks sealed as `status='failed'` despite the worker succeeding (core).** `recordTaskCompletedHandler` read `state.workerStatus` (only set by `rework-stage`); read routes had `workerStatus` only on `state.lastRunResult.workerStatus`. Now falls back to `lastRunResult`.
- **Per-stage counters reset to 0 at stage completion (core).** `lifecycle-driver.completeStage` hardcoded `toolCallCount/filesReadCount/filesWrittenCount: 0` in the payload; `Object.assign` clobbered whatever `recordToolCall` had accumulated during the stage. Now the driver omits those fields so accumulation survives.
- **Heartbeat-after-seal `runner_crash` at terminal (core).** `task-envelope.recordHeartbeat` threw `SealedEnvelopeError` when the periodic timer raced past `seal()` — bubbled up as `runner_crash` and tainted the terminal state. Now a silent no-op once sealed; other mutations still throw because their callers should know they're hitting a finalized envelope.
- **Telemetry queue empty for the daemon's entire lifetime (server).** `serve.ts` called `createRecorder()` AFTER `startServer()`; the bus subscriber called `getRecorder()` during `startServer()` boot, caught the "not initialized" throw silently, and wired `TelemetryUploader` with `recorder=null`. Every event silently dropped. Now `createRecorder` runs before `startServer`.
- **Always-on stderr event stream went silent (core/server).** The 4.7.2 deletion of `VerboseLogChannel` removed the only bus → stderr subscriber. Only 4 hardcoded `[mmagent verbose]` lines in `async-dispatch.ts` remained. Now a `StderrLogSubscriber` is wired alongside `LogWriter` at server boot. Always-on — there is no quiet mode and no `--verbose` flag.
- **LogWriter double-logged to stderr (core).** When `diagnosticsLog=false`, `LogWriter` fell back to writing JSON to stderr — alongside the new `StderrLogSubscriber`. Now `LogWriter` is a no-op when no file writer is configured; stderr is owned exclusively by `StderrLogSubscriber`.
- **Polling `tools=N` counter stayed at 0 even when shell commands ran (core).** `task-envelope.recomputeHeadline.toolTotal` was computed as `reads + writes` — always 0 because codex `run_shell` passes empty file lists. Now `toolTotal = toolCalls.length`.
- **`stages[].tier` always defaulted to `standard` (core).** `lifecycle-driver.startStage` read `provider.tier` which doesn't exist on the `Provider` type — always fell through to `'standard'`. Now reads `ctx.assignedTier`.
- **Rework stage never fired when reviewer returned `changes_required` (core).** `lifecycle-driver.runStagePlan` wrote each stage's gate to `state.gates[name]` but never promoted `review.payload.verdict` / `payload.findings` into the top-level `state.reviewVerdict` / `state.reviewFindings` slots that `rework-stage` gates on. Rework was dead code under the v5 STAGE_PLAN driver — it always skipped with `"rework skipped: review verdict is not changes_required"` even when the reviewer returned `changes_required` with real findings. Missed step in the legacy reviewed-lifecycle → STAGE_PLAN migration. New `hoistReviewPayloadToState` helper runs after every stage advance; rework now fires on `changes_required`. Regression covered by `tests/lifecycle/driver-hoists-review-payload.test.ts`.

### Changed — telemetry wire aggregation (pre-existing 4.7.2 gaps, fixed in same release)

- **Per-stage `inputTokens`, `outputTokens`, `costUSD`, `turnsUsed` now populate from `state.lastRunResult.stageStats[stage]`.** Previously the envelope stages array carried zeros for these even though `mergeStageStats` wrote real numbers into `lastRunResult.stageStats`. `lifecycle-driver.completeStage` now pulls them through; `recomputeTotals` auto-rolls them into envelope totals.
- **`tierUsage` now aggregates from envelope stages instead of hardcoded `{standard: undefined, complex: undefined}`.** Wire telemetry now reports per-tier model + cost + tokens. `standard_model` / `complex_model` / `standard_cost_usd` / `complex_cost_usd` columns will populate in downstream DBs.
- **`agentType` (top-level) derives from `stages[0].tier`** instead of the hardcoded `'standard'` seeded by `async-dispatch`. Matches the actual implementer tier the task used.
- **`review.verdict` wire field reads from envelope `s.verdict`** (populated via `review-stage` → `mergeStageStats` → `lifecycle-driver.completeStage` → envelope) instead of always defaulting to `'skipped'`. Successful reviews now record `'approved'` / `'changes_required'`.
- **`review.tier` + `review.model`** now reflect the actual cross-tier reviewer (complex when implementer is standard, and vice versa) instead of always showing the implementer's tier. `tierUsage.complex` correctly attributes review cost.
- **`annotating.outcome` maps from envelope `s.outcome`** (`'advance' → 'transformed'`, `'fail' → 'failed'`, `'skipped' → 'skipped'`) instead of from the never-set `s.verdict` (which defaulted to `'skipped'` even on successful annotate runs).

### Removed

- **`verbose` concept (CLI flag, config field, type field, dead `verboseStream`).** Stderr event streaming is always-on for `mmagent serve`. The 4.6.0 `--verbose` and `config.diagnostics.verbose: boolean` are gone; `--log` (file-mode JSONL persistence) is the only remaining diagnostics toggle. `ExecutionContext.verbose` and `ExecutionContext.verboseStream` were dead since the 4.7.2 rewrite and are now removed.

### Added

- **`packages/core/src/events/stderr-log-subscriber.ts` (`StderrLogSubscriber`).** Bus subscriber that streams every `PlainLogEntry` to stderr in `[mmagent] event=… ts=… key=val` snake_case format. Exposed via `@zhixuan92/multi-model-agent-core/events/stderr-log-subscriber`. Filters: emits plain entries only; envelope snapshots are intentionally NOT echoed to stderr (too noisy at 5-second heartbeat cadence).
- **Integration test `tests/integration/envelope-pipeline.test.ts` (5 cases).** End-to-end with a recording mock provider — proves envelope threads through executor → SessionOpts → session.send; stage counters survive `completeStage`; envelope seals as `done` for successful read routes; the full bus → uploader → recorder chain delivers an enqueueable record; per-stage tokens + `tierUsage` + annotate outcome wire correctly. This is the test that would have caught every 4.7.3-regression bug.
- **`tests/cli/serve-recorder-init-order.test.ts`.** Source-text check that pins `createRecorder` before `startServer` in `serve.ts` — a future refactor that swaps them breaks this test instead of silently breaking telemetry.
- **`task-envelope-seal.test.ts` regression case.** `recordHeartbeat` is a silent no-op after seal (heartbeat timer can race past seal).

## [4.7.2] - 2026-05-17

Two largely independent strands landed together: a structural events/lifecycle rewrite that replaces the legacy `event-emitter` + sinks fan-out with a `TaskEnvelope` + `EnvelopeBus` + `LogWriter` + `TelemetryUploader` pipeline, and a cleanup of `packages/core/src/identity/` that drops five dormant files and slims the remaining auth helper. Public HTTP routes, skill surface, and CLI commands are unchanged. Telemetry wire schema (`packages/core/src/telemetry/types.ts`) is unchanged — no privacy-disclosure update needed.

### Added

- **`TaskEnvelope` + `TaskEnvelopeStore` (core).** Per-task mutable record that aggregates timings, costs, stage outcomes, findings, and final payload. Async-dispatch state now reads/writes envelopes through a single mutation API instead of layered partial updates across multiple stores. `packages/core/src/events/task-envelope.ts`.
- **`EnvelopeBus` + `Subscriber` (core).** Push-on-mutation bus that fans envelope deltas to in-process subscribers. Replaces the old multi-sink `event-emitter`. `packages/core/src/events/envelope-bus.ts`.
- **`LogWriter` subscriber (core).** File-or-stderr writer fed by the envelope bus. Handles request-side spill for `/audit`-style routes too. `packages/core/src/events/log-writer.ts`.
- **`TelemetryUploader` subscriber (core).** Bus-driven uploader with dedupe and a consent gate; replaces the previous out-of-band recorder calls scattered across lifecycle handlers. `packages/core/src/events/telemetry-uploader.ts`.
- **`PlainLogEntry` + provider-event mapping (core).** Single normalized log-entry shape with explicit field mapping from `claude_tool_call`, `codex_command_completed`, `codex_file_change`, etc. Powers `LogWriter` and the wire projection.
- **`wire-schema.ts` (core).** Future home of `TaskCompletedEventSchema` and the canonical wire projection. `toWireRecord` performs PII projection + exhaustive status mapping. `packages/core/src/events/wire-schema.ts`.
- **`getClaudeOAuth()` keychain test coverage (tests).** New `tests/identity/claude-oauth.test.ts` covers six branches: non-darwin, keychain miss, malformed JSON, missing accessToken, expired token, valid token. Mocks `child_process.execFileSync` via `vi.mock`.

### Changed

- **Lifecycle handlers consume the envelope API (core).** `stall-watchdog`, `annotate-stage`, `lifecycle-driver`, `heartbeat`, the Claude/Codex provider sessions, and the terminal handler all read and mutate `TaskEnvelope` instead of calling the recorder directly. Stage transitions and `costUSD` aggregation flow through the envelope; the recorder now only seals on terminal.
- **`/batch/:id` reads envelopes directly (server).** The HTTP handler converts a `TaskEnvelope` to the public terminal/polling response via a new `envelopeToPublicResult` helper. Removes the previous indirection through the partial-state stores.
- **Request-observability emits plain entries via the bus (server).** Server-side request logs flow through the same `EnvelopeBus` + `LogWriter` chain as task events. Request spill is now a single pathway, not a separate writer.
- **`BatchEntry` slimmed (core).** The store keeps only `taskEnvelopes` plus required infrastructure fields. Headline snapshot fields are removed (envelopes carry that state).
- **`identity/auth-token-store.ts` → `identity/claude-oauth.ts` (core).** File renamed and slimmed; keeps only `getClaudeOAuth()` + `ClaudeOAuthCredentials`. The body of `getClaudeOAuth()` is byte-for-byte unchanged. The single import in `packages/core/src/providers/claude.ts:13` was updated.

### Fixed

- **`event-emitter` downstream propagation gaps (T16/T17).** Stage recording, polling regression, and stale-goldens caused by the deletion sweep are patched in `events` and the contract goldens are refreshed.
- **Residual `updateHeadlineSnapshot` calls (server).** Removed leftover call sites from the earlier T9 worker pass that referenced the now-removed snapshot fields.

### Removed

- **Old `event-emitter` + sinks + dual schemas (core).** Approximately 20 files including the legacy event-emitter, every sink class, `telemetry-channel`, `http-server-log`, and the parallel schema definitions are deleted. The new bus/subscriber chain is the only event pathway.
- **Bootstrap fixtures for the deleted modules (tests).** Implementation-coupled tests rewritten or removed where the underlying module is gone. Observability manifest regenerated.
- **Five dormant files from `identity/` (core).** `cwd-validator.ts` (shadowed by `packages/server/src/http/cwd-validator.ts`), `host-allowlist.ts` (shadowed by `packages/core/src/intake/host-allowlist-builder.ts`), `ssrf-guard.ts` (shadowed by `packages/core/src/research/ssrf-guard.ts`), the unconsumed `identity/index.ts` barrel, plus the dormant `getClaudeAuth`, `getCodexAuth`, `ClaudeAuth`, `CodexAuth`, `claudeOAuth`, `codexOAuth` exports from the old `auth-token-store.ts`. Codex auth is handled by the `codex` CLI subprocess and never needed an in-process token helper (see `packages/core/src/providers/codex.ts:9`).
- **Two dead test files (tests).** `tests/identity/cwd-validator.test.ts` and `tests/identity/codex-oauth.test.ts` — both tested deleted code paths.

### Internal

- **`packages/core/src/identity/` reduced to two files.** After this release the directory contains only `claude-oauth.ts` and `secret-redactor.ts`. Both have at least one live production caller.
- **`ExecutionContext` threads `TaskEnvelopeStore`** (T10–T12 worker) for lifecycle handlers that need to mutate the envelope without reaching for the global store.

## [4.7.1] - 2026-05-17

Two follow-on fixes to the 4.7.0 polling-headline rewire. 4.7.0 made the stage *label* advance through the lifecycle; 4.7.1 makes the `(N/M)` stage *counter* and the live `read / write / tool calls` counters actually move during a task instead of staying stuck at `(1/1)` and `0/0/0` respectively until the very last moment of each stage.

### Fixed

- **Driver-owned visible-stage counter (core).** The per-task polling headline's `(N/M)` segment was permanently stuck at `(1/1)` regardless of which lifecycle stage was running. Root cause: per-handler `heartbeat?.transition()` calls in `review-stage.ts`, `rework-stage.ts`, `git-commit-handler.ts`, `annotate-stage.ts`, and `perform-implementation.ts` all read `state.stageIndex ?? 1` for the counter index — but no code path ever wrote `state.stageIndex`, so the fallback always won. Fix: deleted all five per-handler transition calls; centralized stage-counter ownership in `lifecycle/lifecycle-driver.ts:runStagePlan()` which now fires `tracker.transition({stage, stageIndex, stageCount})` before each visible stage's handler runs. `stageCount` starts at the upper bound (count of `STAGE_PLAN` rows whose `applicableRoutes` match the active route AND map to a user-visible stage) and decrements when a visible stage is skipped via `shouldRun()`. User-visible stages: `implement | review | rework | commit | annotate` → `implementing | review | rework | committing | annotating`.
- **Live progress counters via bus subscription (core).** The `read / write / tool calls` counts in the polling headline stayed at `0 / 0 / 0` for the duration of the implementing stage and only jumped to their final values right before the next stage label appeared. Root cause: the only `tracker.updateProgress(...)` caller in `perform-implementation.ts:248` fires AFTER `session.send()` returns, i.e. once at stage-end. The tracker's `recordFileRead()` / `recordToolCall()` increment methods existed but had no production callers — runners emit `claude_tool_call` / `codex_command_completed` / `codex_file_change` bus events that no one routed to the tracker. Fix: new `packages/core/src/bounded-execution/progress-events-subscriber.ts` module (pattern mirrors `stall-watchdog.ts`) subscribes to the EventEmitter, filters by `batchId`/`taskIndex`, and calls `tracker.recordFileRead()` / `recordFileWrite()` / `recordToolCall()` / `markEvent('tool')` in real time. Wired from `task-runner.ts` alongside the stall-watchdog (started after `heartbeat?.start(1)`, disposed in the existing `finally{}`).

### Added

- **`ActivityTracker.recordFileWrite()`** (core) — increment-style API for the new progress-events subscriber. Mirrors the existing `recordFileRead()` / `recordToolCall()`.
- **Two new acceptance tests:** `tests/lifecycle/driver-stage-counter.test.ts` (4 cases — visible-stage selection, skip decrement, route-applicability filter, no-heartbeat tolerance) and `tests/bounded-execution/progress-events-subscriber.test.ts` (8 cases — per-event-type mapping, task-identity filtering, disposer correctness).

### Internal

- All four per-handler `heartbeat?.transition()` blocks (`review-stage`, `rework-stage`, `git-commit-handler`, `annotate-stage`) deleted, along with their now-orphan `safeTracker` helpers and `ctx` declarations. `perform-implementation.ts` lost its redundant first-stage transition (the driver now owns it).
- Tracker module unchanged besides the `recordFileWrite()` method addition — no event-subscription logic moved into the tracker class.

## [4.7.0] - 2026-05-17

### BREAKING

- **Per-task USD cost caps removed across the entire surface (core + server).** The `defaults.maxCostUSD` config field, the `tasks[].maxCostUSD` HTTP request field on `/delegate` and `/execute-plan`, and the `TaskSpec.maxCostUSD` / `RunOptions.maxCostUSD` type slots are all deleted. Existing user-config files containing `defaults: { maxCostUSD: N }` will fail to load against the new `.strict()` schema; HTTP callers still sending `tasks[].maxCostUSD` will receive `400 invalid_request`. Migration: drop the field everywhere. Reported cost (`actualCostUSD`, `costUSD`) is unchanged — only the *cap* is gone.
- **Status enum narrowings.** `TerminalStatus`, `RunStatus`, and `RuntimeRunResult.cause` no longer carry `'cost_exceeded'`. `IncompleteReasonEnum` and `stopReason` no longer carry `'cost_cap'`. `EventTypeEnum` no longer carries `'cost_check'`. TypeScript consumers that switch/case on these values will see narrowed unions.
- **Removed exports from `@zhixuan92/multi-model-agent-core`:** `DEFAULT_MAX_COST_USD`, `MAX_COST_PRESTOP_RATIO`, `pricingSchema`, `CostCheckEvent`, `RunningHeadlineSink`. The `error-codes` enum no longer contains `'guard_cost_ceiling'`.
- **Module removal:** the entire `packages/core/src/escalation/` folder is gone — escalation/retry logic moved into `lifecycle/perform-implementation.ts` and related handlers. Anyone importing from `@zhixuan92/multi-model-agent-core/escalation/*` subpaths will break at module-load.

### Added

- **Per-task headline snapshot wiring (server).** The `recordHeartbeat` callback in `execution-context.ts` now writes a structured `HeadlineSnapshot` to `perTaskHeadlineSnapshots` on every activity-tracker tick — with `stageLabel`, `stageDone`, `stageTotal`, `toolReads`, `toolWrites`, `toolTotal` populated from the tick info. The polling `/batch/:id` 202 response now reflects current stage and live counts instead of staying frozen on the seed value for the entire task lifetime.
- **Annotating-stage transition (core).** `annotate-stage.ts` now calls `ctx.heartbeat?.transition({stage: 'annotating'})` on entry, so polling shows `Annotating` between Review and Committing.
- **outputTargets contract (core).** `/delegate` and `/execute-plan` tasks accept an optional `outputTargets: string[]`. After the task finishes, `checkOutputTargets()` verifies each declared path exists on disk and emits a `severity: high` finding (`missing_output_targets`) for any path that does not. Paths are normalized cwd-relative at task start.
- **EventEmitter.off()** for listener cleanup (`packages/core/src/events/event-emitter.ts`). Used by the stall-watchdog disposer.

### Changed

- **Reviewer and annotator stage-label vocabulary (core).** `run-reviewer.ts` now passes `{ stageLabel: HUMAN_LABEL.review }` to `session.send` (previously omitted); `run-annotator-turn.ts` now passes `HUMAN_LABEL.annotating` (previously the raw string `'annotate'`).
- **SDK `error_max_budget_usd` subtype (core).** Mapped to `sdkTermination: 'error'` with `errorCode: 'sdk_max_budget'`. Previously mapped to the now-deleted `'cost_exceeded'` terminal status — kept as a defensive branch since the SDK can theoretically still emit this even though we no longer pass `maxBudget`.
- **Per-task session lifecycle (core).** `task-runner.ts` instantiates `ActivityTracker` per task with explicit start/stop, and `perform-implementation.ts` / `review-stage.ts` / `rework-stage.ts` / `git-commit-handler.ts` / `annotate-stage.ts` all report stage transitions to the tracker.
- **ProgressWatchdog defaults (core).** `thrashTurns` default raised from 25 → 50 to reduce false-positive trips on legitimately long workflows.
- **Synchronous session close (core).** Worker close runs synchronously with a 100-child safety ceiling, eliminating a class of orphan codex processes on cancellation.

### Fixed

- **`stuck-detection` per-task scoping + real event names + abort race (core).** Detection was firing on cross-task events because the watchdog reset its idle clock on any event, not just events tagged with the same `batchId`/`taskIndex`. Fixed in `bounded-execution/stall-watchdog.ts`.
- **stall-watchdog disposer removes its bus listener (core).** Without this, every task instantiated a new listener that lived past task termination — slow memory leak proportional to throughput.
- **ActivityTracker ticks no longer forwarded to the observability bus (core).** The tick shape (`kind: 'heartbeat'`) does not conform to the wire event schema (`event: 'heartbeat'`); pushing it caused schema-validation warnings. Ticks now stay on the dedicated `recordHeartbeat` callback channel.
- **`stageStats.implementing.costUSD` preserves `null` (core).** Previously coerced to `0`, which masked rate-card-unresolved cases. Now `null` flows through to telemetry so consumers can tell "free run" apart from "cost unknown".
- **`wall-clock` errorCode propagated into halted stage `timeoutKind` (core).** Halt gates now carry the specific timeout kind instead of a generic string.
- **codex subprocess: spawn detached + kill via process group, settle `consumeStream` on exit (core).** Hardens cleanup; no more orphan codex processes when the parent task aborts mid-run.

### Removed

- **Dead `RunningHeadlineSink` (core).** The sink filtered for `event['event'] !== 'runner_turn_completed'` — a name no producer emits. The activity-tracker path now does what this sink was supposed to. Sink module deleted, public re-export removed, server instantiations removed, two dedicated test files deleted, two incidental references neutralized.
- **Dead `cleanup/` folder (core).** Five wrapper classes that no runtime path consumed. Real cleanup duties live in `BatchRegistry.runExpirySweep`, `FileBackedContextBlockStore.runIdleSweep`, `ProjectRegistry.evictIdle`, and `serve.ts` shutdown handlers.
- **Dead `body-size.ts` middleware (server).** Duplicated a `config/schema.ts` constant and exported a zero-caller `buildServerOpts` helper. Runtime body-size enforcement reads `cfg.server.limits.maxBodyBytes` directly from parsed config.
- **Dormant bounded-execution leftovers (core).** `IdleGuard`, `CostMeter`, `SAFETY_MAX_TURNS`, parallel error-classifier, `partitionFilePaths`, and the bounded-execution barrel index — all unused.
- **Config-folder cleanups (core).** `pricing-table.ts` (dormant façade), the internal `config/index.ts` barrel (no callers), and `validateUserPricing` / `resolveMainAgentModel` / their types from `config-resolver.ts` (test-only via a `load.ts` compatibility re-export). The `serverConfigSchema` block was de-duplicated against the embedded `multiModelConfigSchema.server` block.
- **`@include _shared/budget-defaults.md`** removed from 5 SKILL.md files; the shared doc itself was deleted.

### Internal

- **Stage handlers renamed to `<stage>-stage.ts`** (`refactor(handlers): rename stage handlers to <stage>-stage.ts`).
- **`packages/core/src/escalation/` folder deleted entirely** — write routes now go through `ctx.getSession(tier)` directly, no escalation orchestrator.
- **`findModelProfile` hot path** — lowercase prefixes precomputed once at module load, profile entries frozen, no per-call clone. Cited hot paths: events normalize, cost compute, lifecycle stats.
- **Test fixtures + goldens trimmed** to drop `maxCostUSD` literals, `budgets: { maxCostUSD: undefined }` blocks, `cost_exceeded` mock branches, and the `cost_check` golden entry.

## [4.6.0] - 2026-05-16

### Changed

- **Dispatch behavior for write routes**: `/delegate` and `/execute-plan` now serialize tasks that share a git repository (or share a cwd when not in a git repo), running them in caller input order. Tasks in different repositories still run in parallel. This eliminates a class of silent data loss where two parallel tasks could race on file edits or have one task's commit accidentally include another's mid-flight changes. See `docs/superpowers/specs/2026-05-16-sequential-same-repo-dispatch-design.md`.
- **Reviewer cross-tier inversion (core).** The reviewer stage previously hardcoded `getSession('standard')` regardless of the implementer's tier — the same haiku that wrote the code reviewed it, defeating the "different perspective" intent of code review. Reviewer now runs on the opposite tier: `implementer=standard → reviewer=complex` (capable second-opinion of cheap work) and `implementer=complex → reviewer=standard` (cheap sanity-check of expensive work). Single-tier deployments fall back to the implementer tier. Cost note: standard-tier delegate runs that previously cost ~$0.04 (impl) + $0.02 (review) will now cost ~$0.04 (impl) + ~$0.40 (gpt-5.4 review) — the price of the second opinion.
- **Rework matches implementer tier (core).** Previously hardcoded `'standard'`; now reads implementer tier from `executionContext.assignedTier` (defensive fallback to implementing-stage gate payload, then `'standard'`, then any available provider). Rework's job is to fix the implementer's work, so it needs the same capability.
- **Annotator stage records the canonical model id (core).** Previously emitted `model: null` to `mergeStageStats`, which fell back to the `'custom'` literal at `extractStageData`. The chain `runAnnotatorTurn` → `annotator.ts:240` now passes the real model from `turn.model` through to the stage stats. Visible in telemetry as `stages[annotating].model = 'claude-haiku-4-5'` instead of `'custom'`.

### Added

- Pending-batch headlines now indicate sequential and group status for affected batches (e.g., `(sequential)`, `(group 1/2, sequential)`).
- A `[REPO HYGIENE]` advisory is prepended to a serial task's prompt when the previous task in its group left uncommitted edits.
- `batch_completed` telemetry events gain three additive fields: `groupCount`, `groupSizes`, `serializationApplied`.
- **Cross-tier producer fix for `tierUsage.<tier>.model` (core).** Introduced producer-internal `isLlmStage: boolean` on every stage builder (required field, compile-time enforced). `rollupByTier` now filters out non-LLM stages (synthetic review, commit) before computing tier rollup, so synthetic placeholders no longer corrupt `tierUsage.<tier>.model` under last-seen semantics. Added a tier-uniformity invariant: if two LLM stages share a tier with different models, the tier is omitted from `tierUsage` and an `R-TIER-MODEL-DIVERGENCE` diagnostic is recorded in `validation_warnings`. Added `StageModelMissingError` defense: a `safeBuild` wrapper around each stage builder catches missing-model errors, drops the stage from `stages[]`, and emits a `StageModelMissingError` diagnostic; the rest of the event still ships. The wire schema is unchanged (`isLlmStage` is stripped before emission).
- **Full per-stage token attribution for annotator and reviewer stages (core).** `RunAnnotatorResult` and `RunReviewerResult` now carry `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedNonReadTokens` (read from `turn.usage` on the Session.send result). The annotator handler propagates these through `mergeStageStats` (previously hardcoded to zeros). The review handler newly calls `mergeStageStats('review', ...)` aggregated across spec + quality reviewers — previously the call was missing entirely, leaving `stageStats.review` undefined and `buildReviewStage` returning `null`. The review stage entry was silently invisible in telemetry on every `reviewPolicy: 'full'` delegate / execute-plan run.

### Fixed

- **`stages[*].model` for non-implementer LLM stages no longer reads `'custom'` (core).** Annotator and reviewer were emitting the literal `'custom'` sentinel because their respective turn helpers threw away the model id returned by `Session.send`. Fixed in `run-annotator-turn.ts` and `run-reviewer.ts`.
- **Codex subprocess: spawn detached and kill via process group (core).** Prevents zombie codex processes when the parent task is cancelled mid-run.
- **Codex stream: settle `consumeStream` on `exit`, not just `close` (core).** Earlier behavior could hang waiting for stream close after the subprocess had already exited.
- **`repo-hygiene.ts` `getDirtyFiles`: correct status-prefix strip + handle quoted paths (core).** Old regex `^.{2,3}\s+` allowed variable-width status chars and could swallow leading spaces in paths. Quoted paths (git wraps paths with spaces / non-ASCII in `"..."`) were returned with quotes intact, breaking downstream comparisons. Now uses `substring(3)` for exact-width strip and JSON-parses quoted paths.

### Backend (separate repo `multi-model-agent-telemetry-backend`)

- **Migration 031**: backfill historical `events_raw` rows where the producer wrote the literal `'custom'` into `standard_model` / `complex_model`. Source of truth: `event->'stages'` JSONB with a `costUSD > 0` LLM-billable stage at the target tier, falling back to `event->>'implementerModel'` when `implementerTier` matches the target column's tier. Includes a `tier_attribution_backfill_diagnostics` table that flags rows where multiple distinct non-`'custom'` models share a tier (pre-fix corruption edge case) — those rows are left unchanged for operator review.
- **Migration 032**: two-pass sweep that supersedes 031 for residual state. Pass A re-runs 031's repair to catch rows ingested between 031 deployment and the producer release. Pass B NULLs out the remaining `'custom'` rows where no real model can be derived (legitimate "no LLM stage at this tier" rows under the new producer logic).
- **`tier-attribution-alerts` cron job + `/healthz` integration**: counts (a) regression rows showing `standard_model = 'custom'` with a real `implementerModel` and (b) `validation_warnings` rules `StageModelMissingError` / `R-TIER-MODEL-DIVERGENCE`. Non-zero counts cause `/healthz` to return 503 with a `tierAttribution` detail block.

## [4.5.4] - 2026-05-14

Patch release. Unbreaks telemetry uploads from 4.5.3 daemons — without this fix, the entire 4.5.3 telemetry pipeline is silently dropped at the backend wire boundary.

### Fixed

- **Synthetic review stage emits `costUSD: 0` and `mainEquivalentCostUSD: 0`, not `null` (core).** The 4.5.3 synthetic review stage represented "no LLM call backs this stage" by emitting `null` for cost fields. `task-completion-summary.ts:98` sums stage costs via `sumFinite`, which propagates `null` when any stage is null → top-level `totalCostUSD: null` on the wire. The backend's `UploadEventSchema.totalCostUSD: z.number().optional().default(0)` is non-nullable, so every 4.5.3 daemon upload failed Zod validation and the backend returned `400 {}`. The flusher's existing 400-handling path treats 400 as terminal (`return { status: '400' }` at `flusher.ts:265`) and the queue truncated the record without retry. Net effect: every 4.5.3 daemon's audit/review/debug/investigate event was silently discarded. Live-verified against the production warehouse: post-fix audit row `856074` lands with the daemon-emitted payload and `findings_high: 5` populated from the synthetic stage's `findingsBySeverity`. A synthetic stage represents "no LLM call happened" = 0 cost, not "unknown" — `null` is reserved for honest measurement failures (e.g. a real LLM call whose provider didn't return cost info).
- **`mmagent telemetry status / dump-queue` now resolves the right config path (server).** `cli/index.ts:339` fell back to `os.homedir()` (`~/`) when no explicit `homeDir` was injected by tests. `consent.ts` joined `config.json` against that, looking at `~/config.json` instead of `~/.multi-model/config.json`. Result: `mmagent telemetry status` reported `disabled / source: default` even when the daemon-side resolution (which uses `path.join(os.homedir(), '.multi-model')` at `serve.ts:248`) correctly saw telemetry as enabled. Now matches the daemon path.

### Added

- **Flusher logs telemetry upload failures to stderr (server).** When `/v1/events` returns 400 or 413, the flusher now emits one line: `[mmagent] telemetry upload dropped: status=<code> records=<n> body=<first 200 chars>`. Previously the response status was acknowledged in-memory (record dropped) and the body was never read — every backend rejection was invisible from the daemon side. The 4.5.3 schema-drift bug took two version cycles to surface precisely because the failure was silent at the wire boundary. Now any future schema drift between the daemon's wire shape and the backend's `UploadEventSchema` will print once per flush cycle (5 min) until the queue drains.

## [4.5.3] - 2026-05-14

Patch release. Fixes the warehouse `findings_critical / high / medium / low` columns landing as zero on audit / review / debug / investigate rows. No schema change — uses an existing v5 enum value (`verdict: 'annotated'`) on the existing v5 review-stage entry to carry the per-severity breakdown for read-only routes.

### Fixed

- **Read-only routes now emit a synthetic v5 review stage entry on the wire so per-severity findings reach the warehouse (core).** Audit / review / debug / investigate hardcode `reviewPolicy: 'none'` in their tool-config, so no LLM reviewer runs and no review stage entry landed on the wire — even though the implementer IS the finding producer on these routes and `structuredReport.findings` carries the breakdown. The backend's `findingsTotals()` (transformer.ts:115-130) reads from `stages[?name=review].findingsBySeverity` → with no review stage, `findings_critical / high / medium / low` warehouse columns stayed zero regardless of how many findings the worker produced. The v5 schema already has `verdict: 'annotated'` in the review-stage verdict enum precisely for this case ("annotator extracted findings, no quality verdict reached"). `buildStages` in `event-builder.ts` now synthesizes a zero-metric review stage entry on read-only routes when `projectFindings(rr)` returns at least one finding, carrying `findingsBySeverity` + `concernCategories` derived from the structured report. Zero schema mutation — uses existing v5 fields with an existing v5 enum value. Live-verified against the 19-finding audit row (18 high / 1 medium): the wire payload now emits a review stage with the correct per-severity buckets, and the backend's existing extractor populates `findings_high: 18, findings_medium: 1` without any backend code change.
- **Two regression tests in `tests/telemetry/event-builder.test.ts`** pin the synthesis behavior (audit-shape with findings → synthetic review stage) and the negative case (zero findings → no synthetic stage).

## [4.5.2] - 2026-05-14

Patch release. One telemetry-correctness fix and a large dead-code purge of the pre-v4.4 LLM-annotator machinery. The annotator removal includes dropping the `AnnotatorEngine` and `AnnotatorRoute` public re-exports from `@zhixuan92/multi-model-agent-core` (see BREAKING). No on-the-wire schema or HTTP envelope changes.

### Fixed

- **`concernCount` and `findingsBySeverity` now read from the v4.4 finding surfaces (core).** Pre-fix, `buildTaskCompletedEvent` projected `concernCount: Math.min(runResult.concerns?.length ?? 0, 150)` and bucketed `findingsBySeverity` off the same array. The v4.4 lifecycle collapse moved findings to `runResult.structuredReport.findings[]` (read-only routes, per-finding severity) and `runResult.structuredReport.reviewConcerns[]` (reviewed-write routes, text-only, defaults to medium per the existing wire policy) and stopped writing `runResult.concerns`. Every wire row since 4.4.0 therefore emitted `concernCount: 0`, `findingsBySeverity: {0,0,0,0}`, and `concernCategories: []` regardless of how many findings the worker / reviewer actually produced. New `projectFindings()` helper in `event-builder.ts` reads from the live v4.4 sources; `concernCount`, `buildReviewStage.findingsBySeverity` / `concernCategories`, and `buildReworkStage.triggeringConcernCategories` all derive from the new projection. Live-verified against a real audit on a planted file: pre-fix wire row would have shown `concernCount: 0` with 21 findings on `structuredReport.findings`. Pinned by five new regression tests in `tests/telemetry/event-builder.test.ts`.

### Removed

- **`RunResult.concerns` field (core).** Never written by the v4.4 lifecycle; the wire builder is now the only consumer and reads from the live surfaces.
- **`RunResult.annotatedFindings` and `RunResult.parsedFindings` fields (core).** Always undefined in v4.4 runtime (the LLM-annotator that populated them is gone — see refactor entry below). Headline templates (audit / review / debug) now use `parseNarrativeFindings(runResult.output)` as the canonical fallback when no structured report is emitted.
- **Pre-v4.4 LLM-annotator infrastructure (core).** Deleted `packages/core/src/review/annotator-engine.ts`, `annotator-output-parser.ts`, `annotator-prompt-builder.ts` (~615 lines). The v4.4 lifecycle collapse replaced the LLM-based annotator with the pure-transform handler at `lifecycle/handlers/annotator.ts` that reads worker output directly; `AnnotatorEngine.annotate()` was constructed and threaded as a lifecycle param but never called. Comparing the dead engine against the live `ReviewerEngine` shows it isn't in good shape for reuse — owns its own wall-clock guard / abort controller / bus emission (which in v4.4 belong at the handler layer), takes a `workerOutputs: Array<{criterion, narrative}>` shape designed for the deleted parallel-criteria-dispatcher, hard-codes per-route templates instead of constructor injection. If LLM-annotation is reintroduced, writing a fresh v4.4-style engine (~80–120 LOC, mirroring `ReviewerEngine`'s thin contract) is cheaper than untangling. The rubric templates (`annotator-shared.ts` + `annotator-{audit,debug,review,investigate}.ts`) stay — they provide the rubric content the live quality reviewer consumes.
- **Two small unreferenced legacy modules (core).** `packages/core/src/reporting/annotate-completion-parser.ts` (only imported by its own test) and `packages/core/src/review/review-verdict-aggregator.ts` (only re-exported from the review barrel; no callers in src or tests).
- **`AnnotatedFinding`, `AnnotatorVerdict`, and the duplicate `FindingSeverity` type in `review-types.ts` (core).** The live `FindingSeverity` lives at `reporting/severity.ts`.

### BREAKING

- **`AnnotatorEngine` and `AnnotatorRoute` removed from `@zhixuan92/multi-model-agent-core` public re-exports.** They were dead in production (`.annotate()` was never called by the v4.4 lifecycle); any external consumer that instantiated `new AnnotatorEngine()` would have constructed an orphan that produced no observable effect on the run result. Ships as a patch because no documented or working use existed.

## [4.5.1] - 2026-05-14

Patch release. Two narrow fixes — Windows-compatible codex spawn and a deeper plan/spec audit criteria set that pins the canonical brainstorm→plan flow. No schema or wire-shape changes.

### Fixed

- **`codex-cli-session` spawns via `cross-spawn` (core).** Node's native `child_process.spawn` cannot resolve `.cmd` / `.bat` / `.ps1` shims (e.g. `codex.cmd`) without `shell: true`, but `shell: true` is unsafe for our `-c model_providers.X={…}` argument block — `cmd.exe` would mangle the `{`, `}`, `"`, `=`, `,` characters. `cross-spawn` handles Windows shim resolution AND escaping; on POSIX it is a passthrough so Linux/macOS users see zero behavior change. Fixes the `spawn codex ENOENT` failure reported on Windows 4.5.0 daemons.

### Changed

- **`mma-audit` plan subtype: 9 → 12 perspectives (core).** Plan-audit criteria reorganized into three named groups: **EXTERNAL CODEBASE COHERENCE** (1–8, the existing plan-vs-codebase grounding), **INTRA-PLAN STRUCTURE** (9 TASK GRANULARITY, plus new 11 PLACEHOLDER LANGUAGE and 12 PLAN SKELETON), and **SPEC ALIGNMENT** (new 10 SPEC COVERAGE). Perspective 10 reads the upstream spec from a registered context block (caller passes the spec's `blockId` in `contextBlockIds`) and verifies every spec requirement maps to ≥1 task; emits "No findings for this criterion." when no spec is in context so it stays opt-in without a schema change. Perspectives 11/12 are intra-plan and need only a plan-side quote — no codebase grounding. Evidence-rule, scope-rule, and annotator-awareness blocks rewritten to spell out per-group evidence shape; severity-calibration table extended with new critical/high cases for the added perspectives.
- **`mma-audit` spec subtype: 7 → 9 criteria (core).** Criterion 2 renamed `SCOPE-EXPLICITNESS-AND-DECOMPOSABILITY` and extended to flag multi-subsystem specs that should be split before planning. New criterion 8 `PLACEHOLDER-SCAN` (TBD / TODO / `[fill in]` / empty section bodies). New criterion 9 `DESIGN-DECOMPOSITION-PRESENT` enforces the brainstorming-skill mandate that the spec cover architecture, components, data flow, error handling, and testing strategy. Together with plan perspective 10, the spec ↔ plan boundary is now machine-checkable end-to-end.
- **`mma-audit` SKILL.md updated with the new perspective/criterion lists and a refreshed Recipe F** (Spec-then-plan-then-execute) that instructs callers to register the spec via `mma-context-blocks` so perspective 10 fires during plan audit.

## [4.5.0] - 2026-05-13

Worker-reliability release. Two sub-projects close the largest classes of execute-plan failure seen in production: (A) **commit from git diff, not worker self-report** — eliminates the entire "files written but `filesChanged: []` so commit skipped" failure mode; and (C) **progress-watchdog with three signals** — bounds non-progressing work via wall-clock + turn-count + scope-violation detection so a thrashing worker can't burn the full budget producing nothing. Plus three carry-over fixes for telemetry envelope correctness.

### Added

- **`getRealFilesChanged(state) → {files, source}` (core, sub-project A).** New `packages/core/src/lifecycle/real-diff.ts` derives the canonical written-files list from `git diff --name-only <preTaskHeadSha>` plus filtered untracked files (`git ls-files --others --exclude-standard` minus `state.preTaskUntrackedFiles` snapshot). Returns one of three `source` values: `'git_diff'` (authoritative), `'self_report'` (non-git cwd — falls back to the worker's `filesChanged` for count display only, never commits), or `'git_error'` (git failed mid-task — empty files, no commit). Replaces three read-sites in `git-commit-handler.ts` plus the `filesWrittenCount` source in the telemetry event-builder. Eliminates the "worker wrote files but self-reported `filesChanged: []` so the commit gate skipped" failure mode.
- **`preTaskUntrackedFiles` snapshot at task entry (core, sub-project A).** `task-executor.ts` captures both `preTaskHeadSha` AND the set of pre-task untracked files. Without the snapshot, a tracked file the worker creates would look identical (in `git ls-files --others`) to a file that existed untracked before the task — the snapshot makes "new during this task" deterministic.
- **`scope-match.ts` helpers (core, sub-project C).** `normalizeScopeEntry` classifies brief-declared scope entries as directory or file (trailing slash OR no extension → directory; otherwise file). `isInScope` matches paths against the normalized scope with trailing-slash boundary checking so `src/auth/` does not match `src/authenticate.ts`.
- **Progress-watchdog with three signals (core, sub-project C).** New `packages/core/src/bounded-execution/progress-watchdog.ts` mirrors the stall-watchdog shape: `startProgressWatchdog(ctx) → disposer` arms a setInterval poller (5–30s) that runs `git diff --name-only preSha` and fires `controller.abort()` when `wallClockMs > thrashWallClockMs` AND diff is empty (signal 1: wall-clock thrash). After `session.send` returns, `recordPostHocSignals` checks turn-count thrash (signal 2: `turnsUsed > thrashTurns` AND diff empty) and scope violations (signal 3: any file in the real diff outside declared scope). Skip gates: `!config.enabled`, `toolCategory !== 'artifact_producing'`, missing `preTaskHeadSha` / `preTaskUntrackedFiles`. Wired around `delegateWithEscalation()` in `task-runner.ts` and around `session.send()` in `rework-handler.ts`.
- **Four `defaults.*` config fields (core, sub-project C).** `progressWatchdogEnabled` (default `true`), `thrashTurns` (default `25`), `thrashWallClockMs` (default `1_200_000` = 20 min), `thrashSoftTurns` (default `10`). All optional; existing configs continue to load unchanged.
- **Seven new observability events (core, sub-project A + C).** `real_diff_resolved`, `real_diff_self_report_fallback`, `real_diff_git_error`, `progress_watchdog_armed`, `progress_watchdog_skipped_non_git`, `progress_watchdog_skipped_disabled`, `progress_watchdog_warn`, `progress_watchdog_fired_thrash`, `progress_watchdog_scope_violation`, `progress_watchdog_disarmed`. Registered in `observability-events.ts`.
- **`LifecycleState` watchdog fields (core).** `preTaskUntrackedFiles: Set<string>`, `preStopReason`, `thrashingDetected`, `scopeViolations[]`. Optional — only populated when the watchdog fires.
- **Per-stage `mainEquivalentCostUSD` (core).** Each entry in `stageStats` now carries `mainEquivalentCostUSD` alongside `costUSD`. The frontend Lite page slices per-model savings without re-running the rate-card math; backend stays a pure aggregator. Existing `costSummary.mainEquivalentCostUSD` (task total) is unchanged.

### Fixed

- **`git-commit-handler` reads `filesChanged` from git, not the worker (core, sub-project A).** Pre-fix: the handler trusted the worker's `WorkerOutput.filesChanged` self-report; when the worker self-reported `[]` (false-negative or the calibration bug already fixed in 4.4.0) the commit gate noticed no files and silently skipped. Workers in production observed writing files and then claiming `filesChanged: []` in their JSON. Now the commit handler reads via `getRealFilesChanged(state)`: if `source === 'git_diff'` and files is non-empty, commit; if `source === 'self_report'` (non-git cwd), commit gate still skips but the count flows to telemetry for visibility; if `source === 'git_error'`, treat as empty (refuse to commit on degraded git state). Three read-sites in `git-commit-handler.ts` migrated.
- **`filesWrittenCount` in telemetry sources from real diff (core, sub-project A).** `BuildContext.realFilesChanged` is now the wire source for `filesWrittenCount`; previously the count came from the same self-report the commit handler distrusted. `recordTaskCompletedHandler` became async to call `getRealFilesChanged` before recorder dispatch.
- **`subtype` field reaches telemetry on read-only routes (core).** Pre-fix, the 4.4.0 `subtype` field landed on the HTTP envelope but did not flow into the wire builder; `audit:plan`, `debug:isolated_test`, etc. all appeared in telemetry as the base route name. Fixed by threading `subtype` through `buildTaskCompletedEvent`.
- **Annotating stage emits to `stageStats` (core).** The 4.4.0 lifecycle collapse marked `annotating` as a pure-transform stage that doesn't call `mergeStageStats` — but the wire builder still expected the entry. Now the annotating stage emits a deterministic `entered: true, costUSD: 0, durationMs: <small>` entry so per-stage dashboards stop showing a gap.
- **Dropped dead `reviewPolicy: 'quality_only'` on read-only routes (core).** Read-only routes (`audit`, `review`, `debug`, `investigate`, `explore`) don't run a reviewer pass at all; the `quality_only` policy was set but never observed downstream. Removed the dead assignment.

### Changed

- **`rework-handler` and `task-runner` wrap session calls with the watchdog (core, sub-project C).** Both call sites use the same arm/dispose/post-hoc pattern. Disposer is `finally`-scoped so the timer is always cleared even when `session.send` throws. Disabled in tests via `progressWatchdogEnabled: false`.
- **`lifecycle-context.recordTaskCompleted` signature gains `realFilesChanged: string[]` (core).** The terminal handler computes the canonical list once and passes it through to the recorder; downstream consumers (recorder, builder) read from a single source.

## [4.4.0] - 2026-05-12

Architectural release: session-based provider boundary replaces the 1,559-line runner-shell chain, lifecycle collapses to a single five-stage plan, and the read-only routes consolidate behind a unified `subtype` field. Plus three correctness fixes that materially change cost telemetry and a return to required `X-MMA-Main-Model` after auto-detect proved unreliable.

### BREAKING

- **`Provider.openSession(opts) → Session.send(prompt, opts) → TurnResult` replaces the legacy `RunnerShell` chain (core).** Production providers (`claude-agent-sdk`, codex CLI, `@openai/agents`) expose only `openSession`; the old `run` / `runReview` / `dispose` shims and the 1,559-line runner-shell + RunnerAdapter machinery are deleted. `delegateWithEscalation`, `parallel-criteria-dispatcher`, and `ReviewerEngine.runSpec` / `runQualityAP` / `runDiff` now take an `openSession` factory and assemble their own `RunResult` via the shared `assembleRunResult` helper.
- **Five-stage lifecycle (core).** Stage plan collapses to `implementing → review → rework → annotating → committing`. The pure-transform `annotating` stage stays `entered: false` in `stageStats` (it doesn't call `mergeStageStats`); look at top-level `structuredReport` for its output. Legacy commit-gate fields and the legacy annotate handlers are removed; contract goldens regenerated. `HUMAN_LABEL` from `stage-labels` is the single source of truth for headline labels.
- **`X-MMA-Main-Model` header is required again on tool routes (server).** Reverts the 4.3.0 optional-with-auto-detect chain. The claude-agent-sdk used by our own claude-tier workers writes JSONL files into `~/.claude/projects/<slug>/` with `entrypoint: 'sdk-ts'`, so the resolver returned the *worker's* model (e.g. haiku) as the calling agent's "main" model — telemetry then mis-attributed `costDeltaVsMainUSD` against the wrong baseline. Server now returns `400 main_model_required` when the header is missing. `resolveMainModel` and its test are deleted; all shipped skills updated.
- **Read-only route consolidation (core).** `research` `ToolCategory` is removed; all 5 read-only routes (`audit`, `review`, `debug`, `investigate`, `explore`) share `ToolCategory: 'read_only'` and carry a `subtype` field that captures the per-route variant. `auditType: 'plan'` (4.2.3+) is exposed as `subtype: 'plan'` on `audit`.
- **LLM `verify` tool removed (core).** Verification is now `verifyCommand` only (deterministic shell command); the prior LLM-driven verify route is deleted.
- **Telemetry clamp ceilings raised for 2026-era usage (core).** Per-stage input/cached caps `5M → 100M`, output cap `500K → 2M`, per-stage cost `$100 → $500`, per-task cost `$800 → $5000`. Zod `max()` bounds on `telemetry-types.ts` lift in lockstep. Existing rows below the old caps continue to pass validation unchanged.

### Added

- **`subtype` field on every read-only-route result (core).** Drives downstream filtering / dashboards (e.g. "show me all `audit:plan` runs").
- **`buildPreamble` warm-followup helper (core).** Resumed-session turns (re-entrant criteria, rework, multi-iteration read routes) now emit `buildWarmFollowupMessage(suffix)` instead of re-inlining the brief / diff / planContext. Codex saw 30–40% input-token reduction on long criteria chains — the resumed thread already has the cached prefix, the second turn only needs the new content.
- **Per-criterion termination check (core).** Each criterion turn checks the WallClockGuard before dispatch; previously the guard fired only at the outer stage boundary so a long criteria-fanout could overshoot.
- **`assembleRunResult` helper (core).** Single canonical mapping from `Session.send` outputs + cost + termination → `RunResult` (`actualCostUSD` populated). Both `delegateWithEscalation` and review handlers route through it, so cost / termination-reason mapping cannot diverge.
- **`brief-preamble.ts` (core).** Extracts commit-block + format constraints from a brief once and prepends to the initial session prompt; subsequent turns reference the cached prefix.
- **`tests/providers/codex-cli-session.test.ts` (tests).** Pins the gross→net normalization with a real-world 7.3M/6.66M sentinel case so codex token accounting cannot regress.
- **`tests/contract/http/main-model-required.test.ts` (tests).** Pins the `400 main_model_required` reject + 202 happy path on tool routes.

### Fixed

- **Codex `input_tokens` is GROSS; cached subset must be subtracted before pricing (core).** OpenAI Responses API / codex CLI emit `input_tokens` as the gross count *including* `cached_input_tokens`; Anthropic emits NET (3 disjoint buckets). The codex adapter passed gross through, so `priceTokens` double-billed the cached subset at full + cached rates (~4× cost over-report on cache-heavy turns). Adapter now writes `inputTokens = Math.max(0, gross - cached)` and keeps `cachedReadTokens = cached`. The disjoint-partition contract is documented on the shared `TokenUsage` interface. Verified end-to-end: a smoke task previously reporting $21.60 now reports $4.93 (matches predicted $4.95).
- **`stageStats` per-stage cost now reads `RunResult.actualCostUSD` (core).** `assembleRunResult` populates the canonical `actualCostUSD`; the legacy `cost.costUSD` field is undefined for runs through claude / codex session adapters. `task-runner.ts:517` (implementing) and `rework-handler.ts:110` (rework) both read with the canonical-then-legacy fallback `actualCostUSD ?? cost?.costUSD ?? null`, matching the pattern `delegate-with-escalation` already uses. Pre-fix: every claude-tier implementing and rework stage logged `cost=null` in `stageStats` even when the turn had a real cost; a haiku smoke task reported $0.0000 in stageStats despite spending ~485K cached tokens. Regression-pinned in `tests/lifecycle/handlers/rework-handler.test.ts`.
- **Rework worker `workerStatus` calibration prevents false self-rating as `failed` (core).** Pre-fix, the rework prompt described the summary format (`Fixed: … Could not fix: …`) but never mapped that outcome to the `workerStatus` enum — the worker conflated "the reviewer flagged concerns originally" with "I failed." Two smoke runs that DID fix every reviewer deviation cleanly self-rated as `failed` (run 2) / `done_with_concerns` (run 1), driving the lifecycle headline to `[incomplete]` and over-skipping the commit gate. Fix: explicit `workerStatus` calibration block in `systemPrompt` plus a deterministic Action-step-4 mapping: `Could not fix: (none)` → `workerStatus MUST be "done"`. Regression-pinned in `tests/review/templates/rework.test.ts`.
- **`atomicWrite` `mkdir -p` on the target's parent (core).** Pre-fix, writing to a path under a missing intermediate directory raised ENOENT mid-write; downstream tools treated it as a write failure and retried. Now the parent is materialized atomically before the rename.
- **`sweepProjectCap` respects active projects (core).** The LRU evictor skipped projects with in-flight batches, so the active-set could grow past the cap if all projects were active. Sweep now also drops any project whose last activity is older than the floor — active projects are protected, idle ones evict deterministically.

### Changed

- **Read-route implementer is sequential (not parallel) (core).** The parallel-criteria-dispatcher is deleted; each criterion runs on a single complex-tier session in sequence with warm-followup between turns. Sequential lets each criterion see the prior criterion's edits, which mattered for criteria that build on each other; the dispatcher's parallelism savings turned out to be smaller than the re-investigation cost.
- **`reviewHandler` runs spec then quality on one complex session (core).** Same session, two ordered prompts. Pre-fix, each reviewer opened its own session (cold-prefix tax × 2). Now the spec output sits in cached history when quality runs.
- **`task-executor` parses `WorkerOutput` JSON; captures `preTaskHeadSha` (core).** Workers emit a structured JSON block (`workerStatus`, `summary`, `filesChanged`, `unresolved`, `validationsRun`); the executor parses it and uses `filesChanged` as the canonical written-files list rather than scanning the diff. `preTaskHeadSha` is captured at task entry so the Committing stage can detect "HEAD moved during the task" and refuse to commit on a changed base.
- **`verifyCommand` validator with read-only git allowlist (core).** A new intake validator rejects non-allowlisted commands (`rm`, `mv`, `git reset`, `git push`, etc.) at the 400 boundary; allowlist covers `npm test/build/lint`, `tsc`, `pytest`, `cargo`, and read-only `git status/diff/log` forms. Wired into both `delegate` and `execute-plan`.
- **Heading-label single source of truth (core).** Every lifecycle event emitter reads stage labels from `stage-labels.HUMAN_LABEL` rather than hardcoding strings; pre-fix, `Spec review` / `Quality review` lingered in three places after the 4.3.0 collapse.

### Removed

- **`runner-shell/` (core).** 1,559 lines, three adapters (`anthropic-messages`, `openai-chat`, `openai-responses`), plus the RunnerAdapter / tool-definitions runtime. Replaced by `providers/*-session.ts` modules.
- **`resolveMainModel` resolver + test (core).** Replaced by required-header enforcement (see BREAKING above).
- **Diff-review path (core).** `runDiff`, `ReviewerDiffCallResult`, `DiffReviewerVerdict`, `parseDiff`, and the `buildDiff` reviewer-template method are gone; the diff template is no longer required on `ReviewTemplate`.

## [4.3.1] - 2026-05-11

Telemetry stage vocabulary collapse (schemaVersion 4 → 5, forward-only on mma side; backend will normalise legacy records on read) plus three identity / write-accounting fixes that landed after 4.3.0 shipped.

### BREAKING

- **Telemetry `schemaVersion` bumped 4 → 5; stage vocabulary collapsed (core).** Eight legacy stage names fold into five: `spec_review` + `quality_review` + `diff_review` → `review`; `spec_rework` + `quality_rework` → `rework`; `verifying` → `annotating`; `implementing` and `committing` unchanged. The Zod discriminated union + R-rule validation is rewritten to enforce the new vocabulary; R8/R10/R10b are removed (the single `review` name makes them moot); R9, R10c, R16 retained with renamed semantics. `HeartbeatStage`, `RawStageStats`, observability-events schemas, `StageStatsMap`, and the wire builder (`buildStages`, `buildReviewStage`, `buildReworkStage`, `buildAnnotatingStage`) all line up on the new names. Downstream telemetry backends must consume schemaVersion 5 or normalise on read.

### Fixed

- **`writes_unverifiable` no longer downgrades chat-only responses (core).** The A4b.2 downgrade was designed to catch workers that wrote via shell heredocs (bypassing the path-validity filter) but produced no verifiable artifacts. A worker that responds with chat-only text and never invokes any write tool was being misclassified as `failed`. New `writeAttempted` input gates the downgrade (default true for back-compat); the caller in `composeResponse` computes it from `filesWritten || filesWrittenRejected` being non-empty. Chat-only responses now report `workerStatus: done` cleanly on both HTTP envelope and wire telemetry. Reverts the earlier event-builder priority flip and baseline-handlers state mirror — both became unnecessary once the false-positive trigger was fixed at its source.
- **Claude Code main-model resolver reads `message.model` (core).** The current Claude Code session jsonl records the assistant model under `message.model`, not at top level. The resolver was reading top-level `.model` and finding nothing, so fresh Claude Code sessions returned null — and when an older legacy session with top-level model sat alongside, it picked up the wrong file. Fix: check `message.model` first, fall back to top-level `model` for legacy session files.
- **Claude Code placeholder model literals are skipped (core).** When the latest `~/.claude/projects/<slug>/*.jsonl` `model` field is a placeholder literal (`custom`, `default`, `inherit`, `unknown`), the resolver walks back to the previous real model id, then falls through to `defaults.mainModel` if none is found. Pre-fix, the literal string `custom` leaked into wire telemetry as `mainModel=custom`, which made `costDeltaVsMainUSD` / `mainEquivalentCostUSD` always null because no rate card matched.
- **`writes_unverifiable` downgrade now mirrors onto `state.lastRunResult` (core).** A4b.2 downgrade also writes the post-downgrade `workerStatus` / `errorCode` / `error` onto `state.lastRunResult` so wire telemetry (`recordTaskCompleted` reads `last.workerStatus`) emits the same value the HTTP envelope shows. Pre-fix: HTTP envelope = `failed`, telemetry = `done`. Now: both = `failed`.

## [4.3.0] - 2026-05-11

Major lifecycle redesign + Group A reliability completion. Replaces the experimental 4.2.3 work with a stable architecture; 4.2.3 was never published.

### BREAKING

- **Lifecycle pipeline rewrite (core).** The `spec_review_and_fix` + `quality_review_and_fix` review stages are removed and replaced with a `review` stage (spec + quality reviewers running in parallel, lint-only, readonly tools) followed by a conditional `rework` stage (complex tier, full tools, runs only when at least one reviewer's verdict is `changes_required`). Schema stages: `implementing → review → rework → annotating → committing → finalizing`. Headlines now show `Review` / `Rework`; `Spec review` / `Quality review` labels are retired.
- **`X-MMA-Main-Model` header is no longer required (server).** The 400 `main_model_required` rejection is dropped. A resolver chain (header → per-client auto-detect → `defaults.mainModel` → `unknown_main_model` sentinel) fills in the calling agent's model id. `X-MMA-Client` remains required.

### Added

- **`resolveMainModel` (core, A6.1).** New `packages/core/src/identity/main-model-resolver.ts`. Claude Code clients are auto-detected from `~/.claude/projects/<slug>/*.jsonl` (most recent file's last `model` field); Codex CLI from `~/.codex/config.toml`. Header still overrides; `defaults.mainModel` is the explicit operator fallback.
- **`defaults.mainModel` config field (core).** Reintroduced as the lowest-priority fallback in the resolver chain. Optional.
- **`WallClockGuard` wired end-to-end (core, A10.1-A10.4).** Per-task guard instantiated at task start, threaded through `LifecycleContext.wallClockGuard`. `checkOrThrow()` fires before every non-terminal stage handler and after every tool execution. Guard error sets `state.terminal = true` with `errorCode: 'guard_wall_clock'`; `runOnTerminal` rows still execute so the failure envelope is well-formed.
- **Context-overflow pre-flight estimator (core, A9.1).** New `packages/core/src/intake/context-overflow-estimator.ts` exports `estimateContextSize` + `checkOverflow`. Sums file bytes + context-block lengths + base instructions + reserved completion tokens; emits `context_overflow_predicted` with biggest-contributors + recovery hints when over the model cap. Wired into `runIntakePipeline` so overflow becomes a `HardError` on intake.
- **`HardError.details` field (core).** Optional structured payload on intake hard errors. Used by the overflow check to surface `{ estimatedTokens, modelCap, biggestContributors, recoveryHints }`.
- **`auditType: 'plan'` per-task verdicts (core, A12.4).** New `packages/core/src/tools/audit/plan-audit-verdict.ts` exports `derivePlanTaskVerdicts` + `composePlanAuditSummary`. Verdict rules: `BLOCKED` (≥1 critical), `PARTIAL` (≥1 high, 0 critical), `EXECUTABLE` (no high or critical). Summary block lists 3-bucket counts + "Next blocker" line.
- **Plan-audit end-to-end contract test (tests, A12.6).** New `tests/contract/http/audit-plan-mode.test.ts` + `tests/contract/fixtures/plan-with-symbol-drift.md` verify the `auditType: 'plan'` dispatch shape and the `filePaths.length !== 1` rejection.
- **Stderr diagnostics on tool failure + review error (core).** `runner-shell` logs `[runner-shell] tool X FAILED — err=... input=...` on every tool execution that returns an error result. `review-handler` logs sub-reviewer transport/return errors. Critical for diagnosing silent reviewer no-ops (the bug that revealed itself as `429 rate_limit_error`).
- **Review + rework error fields on the response envelope (core).** New `specReviewError` / `qualityReviewError` / `reviewError` / `reworkError` slots surface transport-layer failures so callers can distinguish "reviewer disagreed" from "reviewer couldn't reach the model".
- **`reviewVerdict` / `reviewFindings` / `reworkOutput` / `reworkApplied` on the public envelope (core).** Each per-task result reports the merged review verdict, the union of spec + quality deviations, and whether rework actually ran.

### Changed

- **Review reviewers retry once on failure (core).** Mirrors `parallel-criteria-dispatcher`: any spec or quality reviewer returning transport error or non-ok status is retried once before the handler gives up. Transient 429 rate-limit errors now self-heal.
- **`shellCommandWritesFs` regex tightened to exclude file-descriptor redirects (core).** Previously `2>/dev/null` (and any `<digit>>` redirect) matched as a filesystem write, inflating the `shellWrites` headline with read-only Discovery commands. Lookbehind `(?<![\d&|>])` excludes fd redirects; the headline `<X> write` count is now accurate.
- **All `mma-*` SKILL.md files swept to drop the hardcoded `X-MMA-Main-Model` header line + curl flag (A6.3).** `_shared/auth.md` documents the header as optional, with the resolver chain.
- **Stage labels in `stage-progression.SCHEMA_STAGE_LABELS` updated (core).** `spec_review` / `quality_review` removed; `review` / `rework` added.

### Fixed

- **`CWDValidator.validate()` no longer throws ENOENT for paths that don't yet exist (core).** `realpathSync(target)` was called unconditionally — for `write_file` on a new path, the file doesn't exist yet, so every `write_file` call failed silently with ENOENT before any byte was written. Workers logged 30+ write attempts with zero files landing on disk. Fix: when the target is missing, resolve the parent's realpath and join the basename. Symlink confinement still applies (parent realpath checked against cwd).
- **Plan-section cap raised 10 KB → 30 KB (core).** A9.1's plan section is 15 KB; the prior cap truncated mid-task, which the worker misread as "task done at Step 4" — root cause of the worker's persistent give-up-at-Step-5b pathology.

Full Group A status: A1.1-A1.7, A4a.1-A4a.4, A4b.0-A4b.2, A6.1-A6.3, A7.1, A9.1, A10.1-A10.4, A11.1-A11.2, A12.1-A12.6 closed. A9.2 deferred per plan.

## [4.2.2] - 2026-05-10

First wave of Group A platform reliability fixes — A1.1 (config caps) + A4b (filesWritten accounting) + A4a (sandbox cwd hygiene). Remaining Group A items (A1.2+, A6, A9, A5, A7, A10, A11) ship in subsequent 4.2.x releases.

### Added

- **`server.limits.maxProjects: 500` config field (core).** New outer-cap on the number of project directories under `~/.multi-model-agent/context-blocks/`. Sets up the LRU sweep that lands in a future patch.
- **`filesWrittenMissing: string[]` field on per-task envelopes (core).** Surfaces entries the worker reported but that didn't pass `stat()` against `taskSpec.cwd` at terminal time. Only emitted when non-empty (common case: `[]`, omitted from envelope).
- **`writes_unverifiable` errorCode (core).** New terminal-stage downgrade for write-intent routes (`delegate`, `execute-plan`): when worker says `done` but produced zero verifiable filesystem artifacts, the envelope returns `workerStatus: failed` / `errorCode: writes_unverifiable` instead of a misleading clean `ok`. Read-only routes (audit/review/debug/verify/investigate/research/explore) are exempt; chain-fail rejection takes precedence when both apply.
- **Stale-sibling cwd rejection (server).** `validateCwd()` now rejects `?cwd=` matching `/tmp/claude/G--*` or `/private/tmp/claude/G--*` with `403 forbidden_cwd`. These directories come from prior Claude Code test runs and produce confused write attribution; prefix-match only so legitimate paths containing `G--` mid-string still pass.
- **Startup hygiene warning (server).** `mmagent serve` scans `/tmp/claude/G--*` and `/private/tmp/claude/G--*` at boot and prints a single `[mmagent] WARNING: N stale Claude Code project sibling(s) under <root>/G--*. ...` line when any are found. Pure log behavior; never blocks startup.

### Fixed

- **`filesWritten` and `filesRead` are now deduped by unique path (core).** Pre-fix: 5 calls to `write_file('foo.ts')` produced `filesWritten.length === 5` on the public envelope and `5 write` in the polling headline. Post-fix: both report `1 write` (one unique path). Spec/quality reviewers reasoning about file CHANGES (set semantics) now see the same count as the brief's "modify N files" requirement. Tool-call count (raw activity counter) is intentionally NOT deduped — every invocation is billable.
- **Polling headline read/write counts source from path Sets, not tool-name buckets (core).** `RunningHeadlineSink` accumulates per-task `Set<string>` of unique read/written paths from per-turn `pathsReadThisTurn` / `pathsWrittenThisTurn` events emitted by `runner-shell`. Falls back to legacy bucket-count semantics for fixtures that don't emit paths.
- **Path-validity filter rejects shell-channel synthetic writes (core).** `runner-shell` no longer adds `shell:<command>` synthetic entries to `filesWritten` (Gap-11's papering over the shell-bypass problem). They now go to a separate `filesWrittenRejected` field on the RunResult, used by the new cross-check downgrade for the daemon-log diagnostic. Five-rule path validator (`filterValidWritePath`): rejects `shell:` prefix, shell metacharacters (`< > | & ; ` `` $ ( )`` ), bad path shape, paths >4096 chars, absolute paths.
- **Default `server.limits.maxContextBlocksPerProject` bumped 32 → 500 (core).** The 32-entry cap was producing `409 cap_exceeded` in normal multi-spec workflows. The 500 default matches the new outer `maxProjects` cap and the spec design's "two-level cap with LRU eviction" architecture.
- **Context-block storage root moves from `~/.multi-model-agent/` to `~/.multi-model/context-blocks/` (core).** Consolidates the two-folder split into a single `~/.multi-model/` root that holds auth, config, identity, install-id, install-manifest, telemetry-queue, and now context-blocks. **BREAKING for callers reading the path directly** — daemon migration to land in a follow-up patch (A1.7); for now, fresh installs use the new path.

## [4.2.1] - 2026-05-10

### Fixed

- **Per-annotator 10-min wall-clock cap (core).** The 4.2.0 merge annotator was unbounded — observed runs at 28+ min on audit batches with N=11 sub-worker narratives. Adds the same 10-min hard / 5-min soft warning pattern used by the warmer + per-angle caps. On hard cap, abortSignal fires; parser yields empty findings; the read-only route's soft-success path returns implementer narratives so the user still gets the per-criterion findings instead of a hung route. Bounds total route wall-clock to ~32 min worst case (warmer ≤10 + max angle ≤10 + merge ≤10).
- **Annotator merge prompt tightened to text-only (core).** The 4.2.0 merge instructions encouraged the annotator to "spot-check whether two findings reference the same code path." The annotator has no tools, so this guidance produced no behavior change in v4.2.0 — but it could mislead readers and was inconsistent with the actual capability. Merge prompt now says "text-only — do NOT read files; you have no tools" and "if you can't dedup confidently from the text, keep both findings and let the reader decide."
- **2 new observability events** for the annotator cap: `criteria_annotator_soft_warning` (5-min checkpoint) and `criteria_annotator_hard_cap` (10-min force-abort). Manifest count now 41.

### Added

- **Per-tier model + provider type at startup (server).** `mmagent serve` now prints one extra line at boot: `[mmagent] tiers | complex=<model> [<provider-type>] | standard=<model> [<provider-type>]`. Operators previously had to inspect `~/.multi-model/config.json` or check verbose-log model fields after dispatching to know which model maps to which tier. When a tier is unconfigured, prints `(not configured)` so a misconfigured slot is visible at boot rather than surfacing at first dispatch.

[Unreleased]: https://github.com/zhixuan312/multi-model-agent/compare/v4.8.0...HEAD
[4.8.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.20...v4.8.0
[4.7.20]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.19...v4.7.20
[4.7.19]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.18...v4.7.19
[4.7.18]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.17...v4.7.18
[4.7.17]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.16...v4.7.17
[4.7.16]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.15...v4.7.16
[4.7.15]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.14...v4.7.15
[4.7.14]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.13...v4.7.14
[4.7.13]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.12...v4.7.13
[4.7.12]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.11...v4.7.12
[4.7.11]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.10...v4.7.11
[4.7.10]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.9...v4.7.10
[4.7.9]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.8...v4.7.9
[4.7.8]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.7...v4.7.8
[4.7.7]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.6...v4.7.7
[4.7.6]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.5...v4.7.6
[4.7.5]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.4...v4.7.5
[4.7.4]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.3...v4.7.4
[4.7.3]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.2...v4.7.3
[4.7.2]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.1...v4.7.2
[4.7.1]: https://github.com/zhixuan312/multi-model-agent/compare/v4.7.0...v4.7.1
[4.7.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.6.0...v4.7.0
[4.6.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.5.4...v4.6.0
[4.5.4]: https://github.com/zhixuan312/multi-model-agent/compare/v4.5.3...v4.5.4
[4.5.3]: https://github.com/zhixuan312/multi-model-agent/compare/v4.5.2...v4.5.3
[4.5.2]: https://github.com/zhixuan312/multi-model-agent/compare/v4.5.1...v4.5.2
[4.5.1]: https://github.com/zhixuan312/multi-model-agent/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/zhixuan312/multi-model-agent/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.2.2...v4.3.0
[4.2.2]: https://github.com/zhixuan312/multi-model-agent/compare/v4.2.1...v4.2.2
[4.2.1]: https://github.com/zhixuan312/multi-model-agent/compare/v4.2.0...v4.2.1

## [4.2.0] - 2026-05-10

### Added

- **Parallel-criteria fan-out for read-only routes (`audit`/`review`/`verify`/`debug`/`investigate`).** Each route's failure-mode taxonomy is now evaluated by N parallel sub-workers (one per criterion / angle / evidence source / perspective) instead of one monolithic implementer. Counts: audit 11, review 10, debug 5, verify 5, investigate 5. The merge annotator dedups across sub-workers and recalibrates severity globally.
- **`RunnerShell.prime()` cache warmer (core).** Sends one minimal turn before fan-out so the upstream prompt cache writes the shared prefix; subsequent N sub-workers serve the prefix from cache. On Anthropic-compatible providers (deepseek/MiniMax claude-compat included), confirmed cache-hit ratio of 0.5–0.92 in smoke tests, with `cached_read_tokens` reported per sub-worker.
- **Per-angle wall-clock cap (10 min hard, 5 min soft warning).** Bounds `max(angle wall)` so total route wall is predictable. Cap-hit angles synthesize a `[N/A]` finding the merge annotator drops gracefully via the three-shape contract; no retry, no failure record. Eliminates the previously-observed 30–80 min runaway angles.
- **Per-warmer wall-clock cap (10 min hard, 5 min soft warning).** Mirrors the angle cap. On cap-hit, dispatcher proceeds to fan-out without cache priming (correctness > optimization). Closes the wall-clock gap where a hung warmer was bounded only by the 60-min task timeout.
- **Three-shape finding contract for answer-finding routes (debug/verify/investigate).** Sub-workers explicitly emit one of: SUBSTANTIVE finding, PARTIAL finding, or NOT-APPLICABLE finding (`[N/A]`-prefixed title, dropped by merge annotator). Eliminates both silent-failure and weak-speculation padding observed in prior iterations.
- **Per-route severity meanings + per-route assignment framing.** Wire shape (`## Finding N:` blocks, 4 severity tiers) is uniform across all 5 routes; *meaning* of each tier is route-specific. Audit/review: severity = problem impact. Verify: severity = decisiveness of pass/fail verdict. Debug: severity = strength of root-cause evidence chain. Investigate: severity = confidence in the candidate answer.
- **Orchestrator stall watchdog (bounded-execution).** The `ctx.stall.controller` AbortController has been declared since v3.x but never armed; a polling timer now fires `.abort()` after `stallTimeoutMs` (20 min default) of no `runner_turn_started`/`runner_response_received`/`runner_turn_completed` events. Eliminates the failure shape where hung provider calls absorbed the full 60-min `timeoutMs` (the "31 min wall, 0 turns, 0 cost" pattern).
- **`SAFETY_MAX_TURNS` constant (200) replacing 5 hardcoded `maxTurns` sites.** `maxTurns` is no longer a normal-budget knob; it is a runaway-loop safety net shared by every provider run (impl, sub-worker, reviewer, annotator) across every route. Real budgets remain `timeoutMs` / `maxCostUSD` / `stallTimeoutMs` (user-configurable).
- **`TaskSpec.parallelTarget` field.** Per-route pure user request text (question / work / problem / document / code) bypassing the legacy monolithic format spec embedded in `task.prompt`. Without this, the dispatcher's cached prefix would inherit the legacy `## Summary / ## Citations` (investigate) or `FINDING_FORMAT_INSTRUCTIONS` blocks, competing with the new `## Finding N:` shape and confusing workers about output format.
- **9 new observability events** for parallel-criteria + stall + cap diagnostics:
  - `stall_watchdog_armed`, `stall_watchdog_fired`
  - `criteria_fanout_warm_start`, `criteria_fanout_warm_complete` (with `cacheControlSent`, `capHit`, `warmerInputTokens`, `warmerCachedNonReadTokens`)
  - `criteria_fanout_warm_soft_warning`, `criteria_fanout_warm_cap_hit`
  - `criteria_subworker_started`, `criteria_subworker_completed` (with `findingsCount`, `cachedReadTokens`)
  - `criteria_subworker_soft_warning`, `criteria_subworker_hard_cap`, `criteria_subworker_retry`
  - `criteria_fanout_summary` (with `cacheHitConfirmed`, `cacheHitRatio`, `succeededCount`, `failedCount`, totals + longest sub-worker)
  - `criteria_fanout_tools_unavailable`
  All registered in `tests/contract/goldens/observability.json` (39 events total).

### Changed

- **`AnnotatorEngine.annotate()` accepts N narratives instead of one.** Signature changed from `workerOutput: string` to `workerOutputs: Array<{ criterion: string; narrative: string }>`. The merge prompt instructs the annotator to dedup by `(file, line, claim essence)`, recalibrate severity using the shared SEVERITY_LADDER, drop `[N/A]`-prefixed findings, and drop `"No findings for this criterion."` sentinels before merging. Single-narrative inputs (N=1) take the same path with no merge-instructions block.
- **`audit`/`review`/`verify`/`debug`/`investigate` now branch on `state.toolCategory === 'read_only'` in `task-runner.ts`** to use the new dispatcher path. Artifact-producing routes (`delegate`, `execute-plan`) keep the existing single-implementer path.
- **`THOROUGHNESS_REMINDER_*` constants removed from sub-worker prompts.** They were calibrated for monolithic single-worker calls and would push sub-workers to invent findings when their criterion legitimately had zero matches. Replaced by route-specific `mustEmitAtLeastOne` flag (true for debug/verify/investigate; false for audit/review).
- **debug taxonomy: 9 anti-patterns → 5 root-cause angles.** Was: SYMPTOM-NOT-CAUSE, SCAPEGOAT FILE, INCOMPLETE TRACE, etc. (warnings to avoid). Now: SYMPTOM-LOCATION ANGLE, RECENT-CHANGE ANGLE, TEST-FAILURE ANGLE, REPRODUCTION ANGLE, CONCURRENCY/CONFIGURATION ANGLE (perspectives to investigate from).
- **verify taxonomy: 7 anti-patterns → 5 evidence sources.** Was: CLAIM-WITHOUT-EVIDENCE, STALE EVIDENCE, etc. Now: TEST-SUITE EVIDENCE, SOURCE-CODE DIRECT-READ, DOCUMENTATION EVIDENCE, RUN-OUTPUT EVIDENCE, DIFF EVIDENCE.
- **investigate taxonomy: 8 quality-warnings → 5 answering perspectives.** Was: WRONG FILE, STALE QUOTE, HALLUCINATED CITATION, etc. Now: DIRECT-SYMBOL-TRACE, CALLER-ANALYSIS, TEST-DRIVEN, CROSS-FILE DEPENDENCY-MAP, DOCUMENTATION/COMMENT-LENS. Citation discipline (no hallucinated `file:line`, always re-read) preserved as within-perspective rule.
- **Anthropic adapter `cache_control` plumbing.** When `RunInput.cacheControl: { type: 'ephemeral' }` is set, the system prompt is sent as `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]` instead of a plain string. OpenAI/Codex adapters accept the field but no-op (auto-caching applies on long shared prefixes regardless).
- **`RunResult` shape adds `workerOutputs`, `partialCriteriaCovered`, `partialCriteriaFailed` fields** (read-only routes only). The `terminationReason` is now always set on the synthesized RunResult so the wire envelope's `terminalStatus` correctly reports `"ok"` instead of defaulting to `"incomplete"` when sub-workers succeed.

### Fixed

- **`stall_watchdog` was declared but never fired.** `ctx.timing.stallTimeoutMs` was captured into the timing struct since v3.x and `ctx.stall.controller = new AbortController()` was created, but no timer ever called `.abort()`. JSDoc in `delegate-with-escalation.ts:38` and `task-runner.ts:230` described this watchdog as if it existed; it didn't. Now wired in `bounded-execution/stall-watchdog.ts` with proper timer cleanup in `runTaskViaDispatcher`'s `finally` block.
- **Misleading `cache_written` field on warmer event.** Detection used `cachedNonReadTokens > 0` which doesn't fire on deepseek's claude-compatible endpoint (they don't break out cache-creation tokens distinctly). Renamed to `cacheControlSent` (true iff we sent the marker) and added `cacheHitConfirmed` to the post-fanout `criteria_fanout_summary` event (true iff sub-workers reported `cachedReadTokens > 0`).
- **Telemetry `terminalStatus` reported `"incomplete"` even when status='ok' on read-only routes.** Wire envelope's `deriveTerminalStatus` reads `terminationReason.cause`; without one, defaults to `"incomplete"`. Now set in the dispatcher branch based on the ⌈N/2⌉ majority threshold.

[4.2.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.1.0...v4.2.0

## [4.1.0] - 2026-05-09

### Changed

- **`mma-delegate` prompt rewritten for smallest-complete-change discipline.** The delegate's purpose is now explicitly framed around the reviewer's standard — the diff should be minimal AND complete simultaneously. Prompt now includes:
  - An orientation block at the top naming the success criterion (reviewer would approve without flagging gaps or extras) and the file-constraint semantics (non-existent paths in `filePaths` are OUTPUT TARGETS; files outside the list are off-limits to write).
  - A 9-category failure-mode taxonomy (scope creep, silent partial fix, wrong file target, phantom test pass, cross-cutting damage, convention drift, incomplete refactor, spec overreach, undocumented assumption).
  - A completeness reminder counter-balancing the worker's tendency to either bloat (extra refactor / cleanup) or skim (declared done with regression test missing). Includes a brief-vs-diff walk: for every brief item, locate the diff hunk that satisfies it; for every diff hunk, name the brief item it satisfies. Both directions must close.
  - A worked example walking the bug-fix-plus-regression-test pattern: naive worker rewrites a function clean and skips the test (SILENT PARTIAL FIX + SCOPE CREEP); correct worker changes one line, adds one test, runs the verifyCommand, stops.
- **Strengthened file-constraint clause.** Replaced the one-line *"write your code to exactly these file path(s)…"* with a contract that distinguishes existing files (modify), non-existent paths in `filePaths` (create), and files outside the list (off-limits unless the brief's task genuinely requires it — and call out the deviation in the summary).

- **`mma-execute-plan` prompt rewritten for fidelity-first plan execution.** The execute-plan's purpose is now explicitly framed around the plan author's standard — the diff should make the author say "yes, that's exactly what I wrote", not "close, but with liberties". Prompt now includes:
  - An orientation block at the top naming the success criterion (plan-author fidelity, not "good code") and explicit fidelity rules (follow the plan exactly, use code blocks verbatim, do not redesign / substitute / improve).
  - A 9-category failure-mode taxonomy (plan rewrite, step skip, step reorder, code substitution, acceptance-criteria overrun, acceptance-criteria underrun, wrong-task match, cross-task contamination, problem-not-flagged).
  - A plan-fidelity reminder counter-balancing the worker's usual "improve it" instinct, with a code-block faithfulness walk and worked example demonstrating CODE SUBSTITUTION (a worker who renames `parse` to `parseTokens` "for clarity" breaks the import contract the plan established).
  - A scope rule explicitly forbidding cross-task contamination (other tasks have other workers; touching their files creates merge conflicts and ownership ambiguity).
- **Restored discipline lines that the slot-style refactor dropped.** The legacy `compileExecutePlan` function had load-bearing lines like *"Follow the plan exactly as written. If the plan provides code blocks, use them verbatim. Do not redesign, do not substitute your own approach. The plan was written by a higher-capability model — your job is to execute it faithfully."* The newer slot-style `buildExecutePlanPrompt` (the canonical path used by the v4 ToolConfig) had silently dropped these. They are now back, integrated into `EXECUTE_PLAN_PURPOSE_ORIENTATION`.

- **`mma-investigate` prompt rewritten for answer-and-act calibration.** The investigate's purpose is now explicitly framed as the loop where the caller acts on the answer — wrong file paths become bugs, stale quotes become wrong edits, overstated confidence becomes misallocated effort. Prompt now includes:
  - An orientation block at the top naming the success criterion (caller acts on this answer literally; would they end up with correct code?) and the four required guarantees per claim (file:line, read this session, every link of synthesis cited, confidence reflects evidence).
  - An 8-category failure-mode taxonomy (wrong file, stale quote, hallucinated citation, confidence overstatement, citation gap, question shift, synthesis without grounding, assumed-current-state).
  - A confidence-discipline reminder explicitly distinguishing evidence strength from assertion strength, plus a citation-chain walk with worked example showing how to verify a claim by reading both the import line and the consumer line.
  - Updated annotator template requiring negative findings to be explicit ("searched X in Y, not found"), validating that cited lines were read in the current session, and accepting inference-with-citations as fully valid (vs. downgrading as speculation).

### Fixed

- **Investigate report parser tolerates backtick-wrapped citations and confidence levels.** Workers commonly wrap the `path:line` portion of a citation bullet (e.g. `` `src/foo.ts:42` — claim ``) or the confidence level (`` `high` — rationale ``) in backticks for visual styling. The previous parser rejected these as malformed, producing 0-citation / unparseable-confidence terminal envelopes despite correct semantic content. The parser now strips a single pair of leading/trailing backticks before matching, conservatively scoped so it does not mangle claims that legitimately contain backticks. Citation format spec updated to clarify that backticks are tolerated but not canonical.

- **`mma-verify` prompt rewritten for false-claim-gate verification.** The verify's purpose is now explicitly framed as the "are we lying when we say it is done?" gate — every PASS becomes evidence trail behind a stakeholder claim, and a wrong PASS ships a false claim. Prompt now includes:
  - An orientation block at the top naming the success criterion (re-verifiable PASS by stakeholder) and three valid evidence shapes (EXECUTION, FILE-LEVEL, NEGATIVE).
  - A 7-category failure-mode taxonomy (claim-without-evidence, stale evidence, implicit-criterion gap, partial coverage, conflated criteria, wrong-artifact evidence, assumed-PASS-on-untested).
  - A thoroughness reminder counter-balancing the shared `SEVERITY_LADDER`'s anti-inflation hint with an evidence-shape walk and worked example demonstrating implicit-sub-criterion detection.
  - Updated evidence rules accepting NEGATIVE evidence ("cannot verify from this artifact, would need X") as the correct verdict for unverifiable claims, no longer collapsing them to assumed-PASS or skipped.
  - Updated annotator template explicitly accepting NEGATIVE-evidence FAILs as fully valid and rejecting prose-claim PASSes as rubber stamps.
  - Per-finding output format expanded to require an Evidence shape (was: file:line OR command output).
- **Effect** (validated on two real-world dispatches against the audit-prompt rewrite this release): truthful 6-item checklist returned 6/6 PASS with file:line and execution-output evidence; 6-item checklist with 4 deliberately-false claims mixed in returned 2/6 PASS with all 4 FAILs at `critical` severity and accurate detection of subtle distinctions like display-text vs enum-value (WRONG-ARTIFACT-EVIDENCE category). 0 rubber-stamps across both runs.

- **`mma-debug` prompt rewritten for symptom-vs-cause-first debugging.** The debug's purpose is now explicitly framed as producing a fix specification a maintainer can apply WITHOUT redoing the investigation. Prompt now includes:
  - An orientation block at the top naming the success criterion (replace, not augment, the maintainer's root-cause work) and the six required output fields per finding (Reproduction, Symptom, Trace, Cause, Fix, Falsifier).
  - A 9-category failure-mode taxonomy (symptom-not-cause, scapegoat file, incomplete trace, untested hypothesis, parallel causes, pre-existing-vs-new entanglement, wrong fix scope, missing reproduction, confidence overstatement).
  - A thoroughness reminder counter-balancing the shared `SEVERITY_LADDER`'s anti-inflation hint, with a symptom→cause walk and worked example tracing a TypeError from a failing test assertion upstream through a route handler to the actual cause in a fixture loader.
  - Updated evidence rules requiring at least three citations per finding (symptom → intermediate state → cause), each with `file:line`. Findings without a falsifier are guesses, not findings.
  - Updated annotator template explicitly accepting partial-evidence hypotheses with marked gaps as fully valid (debug is speculation narrowed by evidence; hand-waving is the failure mode, not careful gap-marking) and rejecting findings where the cited cause is not upstream of the cited symptom.
  - Per-finding output format now prompts for Reproduction / Symptom / Trace / Cause / Fix / Falsifier (was: Hypothesis / Evidence / Fix only).
- **Effect** (validated on a synthetic 4-file Python target with a known symptom-vs-cause separation): worker correctly identified the upstream cause (`discount.py:17` — missing fraction-to-percent conversion) rather than the symptom (`tests/test_handler.py:22` — assertion failure) or the algebraic surface (`discount.py:18` — math expression that is correct given its inputs). 5-step trace, full reproduction + falsifier, HIGH severity calibrated to evidence strength.

- **`mma-review` prompt rewritten for merge-safety-first reviewing.** The review's purpose is now explicitly framed as the pre-merge gate where the maintainer's verdict is treated as authoritative — a miss ships a regression. Prompt now includes:
  - An orientation block at the top naming the success criterion (merge safety) and 10 specific failure-mode triggers a careful maintainer would scan for.
  - A 10-category failure-mode taxonomy (test gap, cross-file ripple, pre-existing-bug-vs-new-regression separation, missing edge case, race / concurrency, resource leak, backward-compat break, security regression, performance regression, implicit-contract assumption).
  - A thoroughness reminder counter-balancing the shared `SEVERITY_LADDER`'s anti-inflation hint, with a cross-file pass and worked example walking `changed symbol → grep → broken caller`.
  - Updated evidence rules accepting cross-file ripple findings (with call-site references) and test-gap findings (with sibling test-file references) as fully valid — no longer downgraded as "speculation about untouched files."
  - Per-focus done conditions rewritten to apply the full taxonomy through each lens; security/correctness/performance now apply to every change regardless of `focus`.
- **Effect**: across three real-source-file dispatches, prompt produces accurate findings with 0 false positives. Cross-file ripple pass actually executes when a diff is provided via `code` field, identifying changed symbols and verifying each call site.
- **`mma-review` SKILL.md updated** to lead with the pre-merge-gate framing and document the diff-as-input pattern for cross-file ripple detection.

### BREAKING

- **`auditType` schema collapsed to `'default' | 'security' | 'performance'`.** The legacy values `correctness`, `style`, `general` and the array form (`['correctness', 'style']` etc.) are removed — they were a false dichotomy that biased workers toward stylistic proofreading on prose artifacts. Sending any legacy value now returns `400 invalid_request`. Migration: use `default` (or omit the field) for the comprehensive sweep; use `security`/`performance` only when you specifically want to narrow the lens to that single dimension. The `auditType` field is now optional with a default of `default`.

### Changed

- **`mma-audit` prompt rewritten for executability-first auditing.** The audit's purpose is now explicitly framed as "make the artifact executable by a low-judgment worker who follows instructions literally." Prompt now includes:
  - An orientation block at the top naming the success criterion (executability) and 10 specific failure-mode triggers a literal-following worker would hit.
  - An 11-category failure-mode taxonomy (recommendation-coherence, internal contradiction, cross-item duplication, independence-claimed-without-evidence, argument soundness, completeness-against-constraints, fix actionability, drift / staleness, scope-creep / framing, structural consistency, metadata completeness).
  - A thoroughness reminder counter-balancing the shared `SEVERITY_LADDER`'s anti-inflation hint (which is calibrated for code-review, not prose-document audits where under-finding is the typical failure).
  - A required principle-mapping pass when the doc has a principles/constraints section, with a worked example that walks `recommendation → constraint → infeasibility`.
  - A fourth valid evidence shape: **internal-coherence** (cross-section reasoning), accepted by the annotator without being downgraded as "speculation."
- **Effect** (measured on a 22 KB recommendations doc): old prompt produced 16 findings across 4 rounds, 0 critical / 0 high / 3 medium / 13 low — almost all stylistic. New prompt produces 9 findings in a single round at 3 critical / 0 high / 3 medium / 3 low — load-bearing executability blockers.
- **`mma-audit` SKILL.md rewritten** to lead with the executability framing and document the new 3-value `auditType` enum.

## [4.0.6] - 2026-05-09

### Fixed

- **`agentType` per-task override honored in delegate routing (core).** `task-executor.ts` resolved one agent per batch using `config.agentType` (each tool's hardcoded default), so delegate's per-task `agentType: 'complex'` request was silently dropped — every task ran on the standard tier regardless of caller intent. Provider was now resolved per task via `task.agentType ?? config.agentType`. Other tools' `buildTaskSpec` already hardcodes their tier (audit/review/verify/debug/investigate/research → complex, execute-plan → standard, retry → inherits original), so this change preserves the policy that delegate is the only tool letting the main agent choose its tier. Added an `agent_not_configured` error path so a misconfigured tier on one task fails just that task rather than the whole batch.

[4.1.0]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.6...v4.1.0
[4.0.6]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.5...v4.0.6

## [4.0.5] - 2026-05-09

### BREAKING

- **`/explore` HTTP route removed.** Replaced by single-task `/research` (external multi-source research only). Migration: callers using `/explore` must now dispatch `/investigate` (for the internal half) and `/research` (for the external half) themselves and synthesise the results. The `mma-explore` skill performs this orchestration if you are calling via skill, not raw HTTP.
- **`mma-explore` skill body rewritten.** It is now a main-agent playbook that fans out `mma-investigate` + `mma-research` in parallel and mandates a 3–5 thread synthesis output (each thread carries one internal citation or sentinel + one external citation or sentinel + a one-line divergence reason, ending with `## Recommended next step`). Skill consumers that scripted against the old single-call `/explore` shape must update.
- **8 explore-specific telemetry events removed:** `explore_parallel_start`, `explore_parallel_end`, `explore_internal_unavailable`, `explore_external_unavailable`, `explore_synthesize_start`, `explore_synthesize_end`, `explore_thread_started`, `explore_thread_completed`. Internal dashboards consuming these must be updated.

### Added

- **`/research` route (server).** Single-task external multi-source research (arxiv, semantic_scholar, github_search, rss, brave-with-`site:`-filters). Schema: `researchQuestion`, `background`, `contextBlockIds`. `reviewPolicy: 'none'`. The previous `/explore` external-leg prompt is preserved verbatim with field renames (`currentContext` → `background`, `explorationQuestion` → `researchQuestion`).
- **`mma-research` skill (server).** Thin 1:1 wrapper around `/research`. Pairs with `mma-investigate` under `mma-explore` for divergent landscape scans.
- **Per-tool integration test for research** (`tests/per-tool/research.test.ts`).

### Changed

- **Synthesis is now main-agent work.** The previous synthesizer worker (no-tools, text-in/text-out) is removed; main agents reading `mma-explore` produce the 3–5 thread synthesis themselves. The 11 actionable skills now span: `mma-audit`, `mma-context-blocks`, `mma-debug`, `mma-delegate`, `mma-execute-plan`, `mma-explore`, `mma-investigate`, `mma-research`, `mma-retry`, `mma-review`, `mma-verify`.
- **Per-tool prompt calibration (core).** `EVIDENCE_GROUNDING / SCOPE_DISCIPLINE / ANNOTATOR_CHECK_AWARENESS_RO` removed from shared `review/templates/finding-criteria.ts`; replaced by per-tool blocks at `tools/<tool>/implementer-criteria.ts` for audit/review/verify/debug/investigate/research. Each tool's worker prompt now uses evidence + scope rules calibrated to its actual job — audit accepts absence-references and cross-section reasoning; debug allows hypothesis-with-partial-evidence and requires cross-file tracing; investigate accepts negative findings ("searched X, not found"); verify binds severity to PASS/FAIL. Shared layer keeps only `SEVERITY_LADDER` and `REVIEWER_AWARENESS_AP` — constants that genuinely apply identically across consumers.
- **Annotator rubric per-tool (core).** `AnnotatorTemplate` extended with `evidenceRule` + `scopeRule` fields; static `ANNOTATOR_RUBRIC` constant replaced by `buildAnnotatorRubric(template)` that interpolates per-tool rules. The annotator now judges findings against the same calibration the worker was given — no more downgrading correctly-emitted absence-findings (audit) or negative results (investigate) or hypothesis chains (debug) for failing a generic "must quote code" rubric.

### Removed

- `packages/core/src/research/explore-orchestrator.ts`, `intake/brief-compiler-slots/explore.ts`, `reporting/parse-explore-report.ts`, `reporting/compose-explore-headline.ts`, `reporting/derive-explore-status.ts`, `reporting/report-parser-slots/explore-report.ts`, `reporting/headline-templates/explore.ts`, `tools/explore/{schema,tool-config}.ts`, `server/http/handlers/tools/explore.ts`.
- 4 contract goldens under `tests/contract/goldens/endpoints/explore-*.json` and `observability/explore-events.json`, plus matching contract + per-tool tests.
- **v3 legacy compile-functions and dead spec-C8 stubs (core).** Dropped `compileAuditDocument`, `compileReviewCode`, `compileVerifyWork`, `compileDebugTask`, `compileDelegateTasks` and the unused v4-iter slot stubs `auditSlot` / `reviewSlot` / `verifySlot` / `debugSlot` / `delegateSlot` together with their tests. Active production paths (`reviewBriefSlot`, `debugBriefSlot`, `compileDelegatePrompt`, plus the per-tool `briefSlot` defined inline in each `tools/<tool>/tool-config.ts`) are preserved.
- **9 stale subpath exports dropped from `@zhixuan92/multi-model-agent-core` (core).** Removed `exports` entries for files deleted in this release — `./research/explore-orchestrator`, `./tools/explore/tool-config`, `./lifecycle/executors{,/index,/investigate,/retry,/shared-compute}`, and `./intake/brief-compiler-slots/{audit,verify}`. Without this cleanup the published tarball would export subpaths that resolve to non-existent `dist/` files. None were part of the documented public API.

### Fixed

- **Telemetry flusher drops every record older than `SCHEMA_VERSION`** (not just a contiguous head-prefix). A sandwiched stale record (queued during a roll-back/forward, or `installId` churn after re-enrollment) used to either propagate into an upload and 401/400 server-side, or split the upload into versioned groups. New `Queue.removeRecords(hashes)` rebuilds the queue file from scratch; flusher hashes records with `schemaVersion < SCHEMA_VERSION` OR mismatched `installId`, calls `removeRecords` once, then refreshes meta byteOffsets.
- **`/research` HTTP handler shape (server).** Handler was calling `runTaskViaDispatcher` directly and returning a raw `RunResult` instead of the standard 6-field `ExecutorOutput` envelope — headlines were missing, `results[]` was empty, and `main_model` wasn't propagated from the `X-MMA-Main-Model` header. Rewritten to use the v4 generic `executeTask` orchestrator (matches the investigate / verify / delegate handler pattern). `EnrichedResearchInput` now carries `userSources` + `hasBrave` + `resolvedContextBlocks`; `briefSlot` compiles the prompt without handler-side cwd plumbing.
- **Telemetry route enum missing `'research'` (core).** `route` enum in the wire schema (`events/telemetry-types.ts`) and `BuildContext.route` (`event-builder.ts`) didn't include `'research'` after the 4.0.5 cutover. Recorder logged `mma-telemetry: schema warning` on every research event (rows still flushed under warn-only validation). Now silenced and pinned in the wire contract.
- **Subpath export missing for research tool config (core).** `packages/core/package.json` was missing the `./tools/research/tool-config` ESM subpath, so the server handler's import resolved nowhere. Added next to `./tools/research/schema`. Stale `./tools/explore/schema` entry left over from the route deletion was also removed.
- **Synthesized implementing stage uses configured model (core).** When the runner crashes before any LLM call fires (`runner_crash` / `all_tiers_unavailable` / dispatcher-no-result), `ensureImplementingStage` now reads the configured implementer model from `ctx.implementerProvider.config.model` instead of stamping `null`. The synthesized stage and top-level `rr.models.implementer` now report the *intended* model (e.g. `deepseek-v4-pro`, `gpt-5`) — the wire row carries the correct family rather than the literal `'custom'` event-builder fallback.

[4.0.5]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.4...v4.0.5

## [4.0.4] - 2026-05-08

### Fixed

- **DiffTracker (NEW: `lifecycle/diff-tracker.ts`) — give reviewers actual diff evidence.** Pre-fix every reviewer template (spec / quality / diff) saw only `Task: <brief>` + `Worker output: <text>` and judged the worker's CLAIM rather than the actual change on disk — defaulting to `changes_required` and triggering endless rework spirals on already-correct work. Snapshot-based (works in non-git directories), captures pre-task baseline and produces unified-diff output (Myers-style line LCS) on demand, capped at 50KB with truncation marker. Reviewer templates rewritten to receive `diff` + `priorConcerns` fields so verdicts must point to specific diff lines.
- **Coherent prompts via shared finding-quality rubric (NEW: `review/templates/finding-criteria.ts`).** Pre-fix the implementer prompts didn't share the annotator's rubric, so workers emitted weak narrative (miscalibrated severity, unsupported claims, speculative scope) and the annotator had to either downgrade everything or rubber-stamp. Single source of truth for severity ladder, evidence-grounding, scope discipline, and stage-awareness criteria. Read-only tools (audit / review / verify / debug / investigate) get `ANNOTATOR_CHECK_AWARENESS_RO`; artifact-producing tools (delegate / execute-plan) get `REVIEWER_AWARENESS_AP` describing the spec + quality reviewer rubric. Workers self-align with what each reviewer will judge → cleaner first-round outputs → fewer rework spirals.
- **Lenient JSON parsers (`reviewer-output-parser.ts` + `annotator-output-parser.ts`).** Both parsers were too strict (only ` ```json ` fenced blocks). Some models emit bare JSON, fenced without a language tag, or arrays/objects embedded in prose. Parsers now walk three shapes with balanced-brace counting (string-literal aware): fenced ```json``` → fenced ``` (no lang) → bare `{...}`/`[...]` anywhere in the text. Caused `verdict: 'error'` and `findings_low: 0` regressions despite valid annotator output.
- **`replaceLastRunResultPreservingTrackers` (`merge-stage-stats.ts`) — cumulative `filesWritten` across rework rounds.** Pre-fix the spec/quality chain handlers replaced `state.lastRunResult` wholesale on every rework round (only `stageStats` preserved), so the implementer's `filesWritten=['x.ts']` was wiped when a no-op rework round ran. Envelope showed `filesWritten=[]` despite the file having been modified on disk; downstream `qualityReviewStatus` collapsed to "no file artifacts to review". Now: union `filesRead` / `filesWritten` / `toolCalls` arrays across rounds.
- **Headlines unified across all tools.** `delegate`, `execute-plan`, `retry`, `debug` headlines now follow the same `[<status>] <route>: <summary>` format as `audit` / `review` / `verify`. Pre-fix `execute_plan:` (snake-case), `retry: N/N tasks complete` (no status prefix, never reflected actual outcome), `debug: 1/1 tasks complete` (no status prefix, no findings count) all diverged from operator-facing convention.
- **Investigate prompt aligned with parser.** Pre-fix the implementer prompt asked for a numbered-narrative format but the parser expected `## Summary / ## Citations / ## Confidence` sections — every investigation reported `0 citations, confidence unparseable`. Prompt rewritten to request the exact section format the parser handles. Brief field renamed (`prompt` → `compiledPrompt`) so the headline reads the user's actual question, not the prompt template instructions.
- **Verify narrative parser + severity wording.** `verifyReportSchema` now accepts both JSON blocks and `## Finding N:` narrative (the prompt explicitly says "Do NOT emit JSON"). Severity field changed from `Severity: low for PASS, medium or high for FAIL` (which produced literal value `low for PASS` that the annotator's enum normalizer rejected) back to `Severity: critical | high | medium | low (use 'low' for PASS items)`. Wire `findings_low` now correctly reflects PASS-item count.
- **Spec-rework + quality-rework concerns accumulated across rounds.** New `priorSpecConcerns` / `priorQualityConcerns` slots on `LifecycleState` carry concerns from earlier rounds into later ones, so round N+1's reviewer can verify the rework addressed prior issues rather than re-deriving them.
- **`headline-text.firstSentenceOrTruncate` hardened.** Off-by-one regex bug (could return `safeMax+1` chars), newline collapse before sentence detection, defense against invalid `max` values (NaN / Infinity / 0 / negative all coerced to safe defaults).
- **Per-tool `filePaths` + `mainModel` propagation onto `TaskSpec`.** Review / verify / debug / investigate `buildTaskSpec` were dropping `ctx.mainModel` and (in some cases) `brief.filePaths`, so the headline composer couldn't name the file and wire telemetry was missing main-model attribution. Audit had this right; the others now match.
- **Implementer system prompt: trust `edit_file`/`write_file`.** Workers were defensively re-reading files after successful `edit_file` calls — wasted 4-6 minutes per artifact-producing task on slow models. New rule: "if the tool returns without an error, the edit applied. Do NOT re-read a file just to verify your own successful edit."
- **Retry headline + verdict preservation.** `postProcessEnvelope` previously hard-coded `retry: N/N tasks complete` regardless of actual per-task status, hiding `review_loop_capped` outcomes from operators. Now aggregates ok/incomplete/error counts and emits a status-prefixed headline; preserves `specReviewVerdict` / `qualityReviewVerdict` / `roundsUsed` on the envelope.
- **Debug rewritten as proper read-only.** `done` clause and finding format both said "Verify the fix resolves the problem" — but debug is read-only and can't apply fixes. Now: "PROPOSE the fix; do NOT apply it; the caller decides whether to apply." Cap of 3-5 most-likely hypotheses (was unbounded).

### Removed

- **Dead investigate compilers.** `intake/brief-compiler-slots/investigate.ts` exported `compileInvestigate` and `investigateSlot` with no production callers — only three test files exercised them. Deleted (per dev-mode rule "delete unused code"). New minimal `tests/per-tool/investigate.test.ts` exercises the actual production `toolConfig.briefSlot` to keep `path-coverage.test.ts` green.

## [4.0.3] - 2026-05-08

### Fixed

- **Telemetry attribution end-to-end (`client`, `mainModel`, family).** Pre-fix, every wire row reported `client = 'other'` and `main_model = NULL` because the daemon had no way to know which calling agent was dispatching. New required headers `X-MMA-Main-Model` and `X-MMA-Client` are enforced at the request boundary on every tool route — server returns `400 main_model_required` / `400 client_required` if missing. Drops the unreliable daemon-wide `defaults.mainModel` config + `PARENT_MODEL_NAME` env: a single daemon serves multiple parents (e.g. Claude Code + Cursor sessions concurrently), so the header per-request is the only correct source. All 10 shipped SKILL.md curl examples updated; `_shared/auth.md` documents the two new headers.
- **Canonical model-name preservation on the wire (`mainModel`, `implementerModel`).** `extractCanonicalModelName` previously collapsed `claude-opus-4-7` → `claude-opus`, losing version info on every Anthropic model. Now preserves model + version across vendor namespaces (`bedrock.claude-opus-4-7`, `vertex_ai/anthropic.claude-sonnet-4-6@2024-10-22`, etc.), strips date/release suffixes (`@YYYY-MM-DD`, `-YYYYMMDD`, `-latest`, `-v1`), removes wrapper boundaries (`_`, `:`, `@`), and supports best-effort substring extraction for ids embedded in arbitrary wrappers (`my_router_42_claude-opus-4-7_xyz` → `claude-opus-4-7`). `findModelProfile` still uses prefix collapse for cost lookup — separate concern.
- **`parent*` → `main*` rename through the wire.** Wire schema now carries `mainModel`, `mainModelFamily`, `mainEquivalentCostUSD`, `costDeltaVsMainUSD` directly (matches DB column `main_model`). `buildWirePayload` no longer translates — internal === wire. Backend projection layer needs the corresponding read-side rename in lockstep (separate ticket).
- **`contextBlockIds` reach the worker prompt (Gap 1, CRITICAL).** Pre-fix, `runTaskViaDispatcher` expanded the task into `executionContext.task` but the dispatcher dispatched the original unexpanded `input.task`; the executor read `state.task` (unexpanded) so the worker never saw the prepended block content. Round-over-round audit recipes were broken end-to-end. Now the task is expanded ONCE up-front and the same reference flows through both `state.task` and `executionContext.task` (single source of truth). Cache invariant: `task-executor.ts` expands BEFORE writing to `projectContext.batchCache` so retry sees the expanded prompt directly.
- **Headline reads `runResult.annotatedFindings` when `report.findings` is empty (Gap 2).** Audit/review headlines previously reported `0 findings (0 high)` whenever the worker emitted narrative `## Finding N:` blocks instead of structured JSON — the per-tool `reportSchema` parse failed and the structuredReport fallback didn't have a `findings` field. Composer now falls back to `runResult.annotatedFindings`, populated by the quality-chain handler. Path also falls back to `task.filePaths[0]` when `report.documentPath` is missing.
- **`HeadlineTemplate.compose` signature extended with `runResult` + `task`.** Backwards-compatible (both optional). Composers that ignore them keep working; audit/review use them for the Gap 2 fallback.
- **Severity helpers split — headline aggregate vs telemetry buckets.** New `reporting/severity.ts`: `normalizeSeverity` (lowercase canonicalizer), `countHighOrCritical` (HEADLINE-only — `high` + `critical` both count), `bucketFindingsBySeverity` (TELEMETRY-only — exact per-bucket counts). Telemetry `findings_critical/high/medium/low` columns are now computed from the bucket helper and can't be conflated with headline counting.
- **`totalDurationMs` reflects real wall-clock (Gap 3).** Pre-fix, `runResult.durationMs` only covered the implementer's `shell.run`, missing reviewer/annotator stages — wire `totalDurationMs` reported ~30s when an audit took ~165s. The proportional scale-down that "fixed" R4 was masking this by silently shrinking per-stage durations to fit. Now: `totalDurationMs = max(runResult.durationMs, Σ stageDurations)` — for sequential v4 stages, the stage sum wins (correct). Drops the scale-down. Per-stage durations stay truthful. `task-executor.ts` also sets `result.durationMs = wallClockMs` on every return path including failure envelopes (was 0 — invisible in retry budgeting).
- **`batch_failed` fires when executor packages an error envelope (Gap 5).** Previously, `task-executor.ts` caught errors and packaged them with `structuredError`/`status: 'error'` rather than throwing; `async-dispatch.ts` saw a "successful" return and emitted `batch_completed`, hiding the failure from operator-facing telemetry. New `detectFailure` helper inspects the envelope using STRUCTURED FIELDS ONLY (no string comparisons): any task with `structuredError`, any task with `status === 'error'/'failed'`, or envelope-level `error.kind !== 'not_applicable'` triggers `batch_failed`. `incomplete` status excluded — review-rework intermediate state isn't a categorical failure.
- **Stage-progression denominator derives from `StagePlan` (single source of truth).** Pre-fix, two duplicated lists (one in async-dispatch, one in RunningHeadlineSink) computed the polling bracket. Audit reported `(1/9)` because the read-only StagePlan filter wasn't applied. New `lifecycle/stage-progression.ts` simulates each row's `runCondition` under route defaults — audit shows `(1/3)`, delegate `(1/9)` including reworks, register-context-block `(1/1)`, etc.
- **File-backed context-block persistence (Gap 4).** Context blocks now persist to `<projectCwd>/.mma/context-blocks/<id>.txt` with atomic writes (temp + fsync + rename), permissions `0700`/`0600`, 7-day TTL, 1 MiB per-block + 100 MiB per-store caps, oldest-first eviction. Round-over-round audit recipes survive daemon restarts. `.mma/` added to `.gitignore`; `PRIVACY.md` documents the local-only directory. (Note: In 4.7.10 this was superseded by unconditional in-memory storage; see Removed section.)
- **`run_shell` write tracking (Gap 11).** Worker writes via `cat >`, `sed -i`, `tee`, etc. used to show `0 write` for the entire run despite actively producing artifacts. New `shellCommandWritesFs` heuristic detects common write patterns; the runner-shell emits `shellWrites` on `runner_turn_completed`; the polling sink + `runResult.filesWritten` both reflect real activity. False-negative-averse — better to over-report than silently lie about progress. Stderr-merge `2>&1` explicitly excluded.
- **Centralized tool-name sets (Gap 14).** Pre-fix, `RunningHeadlineSink.WRITE_TOOLS` was `{writeFile, write_file}` while `runner-shell` had `{..., editFile, edit_file}`. Worker calling `edit_file` correctly bumped `runResult.filesWritten` but the polling headline reported `0 write`. New `providers/tool-name-sets.ts` is the single source of truth — both consumers import from it; drift impossible without editing the shared module.
- **Per-task `reviewPolicy` reaches the wire (Gap 15).** Previously `event-builder.ts` always fell back to the route default — wire reported `'full'` for delegate even when the task dispatched with `reviewPolicy: 'none'`. `terminal-handlers.ts` now threads the per-task value into the recorder call.
- **Delegate headline reads `runResult.filesWritten` when `report.filesChanged` is empty (Gap 13).** Same source-of-truth pattern as audit Gap 2 — workers that write via `edit_file` populate `filesWritten` but rarely emit a structured `filesChanged` array, so the headline used to report `(0 files)` despite a successful edit.
- **One-sentence headline trim (Gap 12).** New `reporting/headline-text.ts:firstSentenceOrTruncate` keeps the operator-facing headline short and deterministic. Worker summaries can be paragraphs long and end mid-sentence; pre-fix, the entire summary was inlined verbatim. Used by delegate + execute-plan composers.

### Added

- **Stage progression exports** `STAGE_ORDER_BY_ROUTE`, `stageProgress`, `stageOrderForRoute` from `@zhixuan92/multi-model-agent-core/lifecycle/stage-progression`.
- **All shipped skills (10 SKILL.md files)** now include `X-MMA-Main-Model` + `X-MMA-Client` headers in their curl examples and document the `400 main_model_required` / `400 client_required` errors.

### Changed

- **`extractCanonicalModelName` semantics** changed to preserve model + version (was: collapse to profile prefix). Tests rewritten accordingly. `findModelProfile` still uses prefix collapse for cost lookup — distinct concern.
- **`HeadlineTemplate.compose` signature** added optional `runResult: RunResult` and `task: TaskSpec` params. Backwards-compatible.
- **`ContextBlockStore` interface** extended with `size`, `pin`/`unpin`/`refcount`, `clear`, `ttlMs` so callers can program against the abstraction (both in-memory and file-backed implementations satisfy the same contract).
- **`createProjectContext`** now defaults to `FileBackedContextBlockStore`; `createInMemoryProjectContext` is the new test-only convenience.

### Removed

- **`config.defaults.mainModel`** — replaced by the required `X-MMA-Main-Model` header.
- **Wire field rename shim in `buildWirePayload`** — internal record now matches wire shape 1:1 (was translating `mainModel*` → `parentModel*`).
- **Proportional stage-duration scale-down in `event-builder.ts`** — was masking the implementer-only `runResult.durationMs` bug fixed by Gap 3.

### BREAKING

- **`X-MMA-Main-Model` and `X-MMA-Client` are required on every tool route.** Callers using the shipped skills (Claude Code, Codex, Gemini, Cursor) get this for free after `mmagent sync-skills`. Custom callers MUST add both headers; server returns `400` otherwise. This is a deliberate hard gate for telemetry attribution correctness.
- **Wire schema field rename:** `parentModel` → `mainModel`, `parentModelFamily` → `mainModelFamily`, `parentEquivalentCostUSD` → `mainEquivalentCostUSD`, `costDeltaVsParentUSD` → `costDeltaVsMainUSD`. Backend projection layer needs the read-side rename in lockstep (separate ticket).
- **`config.defaults.mainModel` removed.** Header is the only source.

## [4.0.2] - 2026-05-07

### Fixed

- **Server build now pre-cleans `dist/`** so deleted source files don't leave orphan `.js` / `.d.ts` artifacts in the published tarball. Mirrors the existing `prebuild: rm -rf dist` already on `packages/core`. Without this, the v4.0.2 tarball shipped with stale `dist/cli/install-skill.js` + `dist/cli/update-skills.js` files for the commands removed in this same release. Trim: 305 → 225 files.
- **`/batch/:id` polling no longer reports "0/1 queued" forever once the executor has begun.** Root cause: `async-dispatch.ts` set `entry.tasksStarted = 1` when the executor body fired, but did not bump `entry.runningHeadlineSnapshot.prefix` — that field was only updated by heartbeats from the runner. Heartbeats come from inside `provider.run`, so when an LLM call was slow (e.g., a multi-second deepseek API call), the polling endpoint kept returning the initial `"0/1 queued"` fallback for the entire duration of that call. From the outside this was indistinguishable from a daemon-level deadlock — the symptom that prompted users to restart `mmagent serve` to "unstick" perfectly healthy in-flight batches. async-dispatch now updates the headline snapshot to `"1/1 running, Xs elapsed"` the instant the executor begins. Same code path also emits two new verbose-stderr breadcrumbs (`executor_started` and `batch_completed` / `batch_failed`) gated on `diagnostics.verbose=true`, so operators tailing the daemon see the full request lifecycle without grepping the JSONL log. Tests: regression in `tests/server/async-dispatch.test.ts` pins the snapshot transition to `"1/1 running"` while the executor is in flight; `tests/contract/goldens/endpoints/retry-tasks-error.json` updated for the new line numbers in async-dispatch.ts.

### Changed

- **`mmagent install-skill` and `mmagent update-skills` collapsed into a single `mmagent sync-skills` command.** The two commands disagreed on what was canonical: `update-skills` iterated the manifest, `install-skill` iterated user-supplied flags, and the daemon's drift detector (in `serve.ts`) iterated on-disk client dirs. A user with an empty manifest and existing client dirs would see all 22 (skill × client) entries reported as missing in the daemon warning, but `update-skills` would say "0 updated, 0 errors" and `install-skill` had no obvious "just sync everything" mode. `sync-skills` is a single idempotent upsert: detect installed clients, install any missing supported skill, overwrite skills whose installed version differs from canonical, drop skills that disappeared from the bundle (orphans), and rewrite the manifest to match. Replaces both old commands; postinstall now runs `sync-skills --if-exists --silent --best-effort`. Daemon drift warnings, the `mmagent status` "incompatible" hint, and both READMEs / `DIRECTION.md` updated to point at `sync-skills`. Tests: 9 in `tests/cli/sync-skills.test.ts` pinning bootstrap, up-to-date short-circuit, version upgrade, orphan removal, dry-run, target scoping, no-clients-detected, and `--if-exists` postinstall guard.

### Removed

- **`mmagent install-skill` subcommand** — superseded by `mmagent sync-skills`.
- **`mmagent update-skills` subcommand** — superseded by `mmagent sync-skills`.

## [4.0.1] - 2026-05-07

### Fixed

- **`mmagent install-skill` and `mmagent update-skills` resolve their bundled SKILL.md correctly under every npm-install layout.** The 4.0.0 refactor that moved skill-discovery from server into `core/tool-surface/discover.ts` (commit `e886794`) added candidate paths only for the monorepo dev tree (`packages/server/src/skills/` and its `dist` mirror). Globally-installed users (`npm i -g @zhixuan92/multi-model-agent`) saw `Skill 'multi-model-agent' not found. Checked: .../node_modules/@zhixuan92/server/src/skills/multi-model-agent/SKILL.md` for every shipped skill — that path is fictional (the package is `@zhixuan92/multi-model-agent`, not `@zhixuan92/server`). `locateSkillsRoot` now also probes the npm-installed sibling layout (`node_modules/@zhixuan92/multi-model-agent/dist/skills`) and the core-nested-under-server layout (`.../multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/.../dist/skills`). Tests: 4 in `tests/tool-surface/skills-root-resolution.test.ts` covering every layout. Affects `install-skill`, `update-skills`, and any caller that goes through `getSkillsRoot()` without an explicit override.

## [4.0.0] - 2026-05-04

Major release: structural rebuild of the labor substrate. Same product surface as 3.12 minus the deliberate clarification removal; all callers must migrate per the Breaking changes list below.

### Breaking changes

- **`reviewPolicy` closed to 4 values:** `'full' | 'quality_only' | 'diff_only' | 'none'`. Removed `'spec_only'` and `'off'`. Callers using `'off'` should send `'none'`; callers using `'spec_only'` should send `'full'` (note: `'full'` runs both spec and quality reviews).
- **`agentType` closed enum:** `'standard' | 'complex'`. Free-form values are rejected at HTTP/Zod with HTTP 400.
- **`tier` labor-tier enum closed:** `'standard' | 'complex'`. `'main'` removed (kept only as a caller-role concept on `mainAgentModel`).
- **`workerStatus` rename:** `'review_loop_aborted'` → `'review_loop_capped'`.
- **`mainModelFamily` drops `'gpt-5'`:** family value is `'gpt'`; `'gpt-5'` is a model id.
- **errorCode renames:** `verify_command_error` → `validator_verify_command_failed`; `dirty_worktree` → `validator_dirty_worktree`. Removed orphan `lifecycle_round_cap_exceeded`.
- **errorCode dropped:** `intake_clarification_expired` (clarification flow removed).
- **Token shape: 5 fields → 4.** `cachedCreationTokens` → `cachedNonReadTokens`; `reasoningTokens` removed (folded into `outputTokens`). Canonical shape: `{inputTokens, outputTokens, cachedReadTokens, cachedNonReadTokens}`.
- **Wire field rename:** internal `mainModel*` ↔ wire `parentModel*`. Telemetry SCHEMA_VERSION bumped to 4.
- **Annotator field rename:** `reviewerConfidence` → `annotatorConfidence`.
- **Routes:** added `register-context-block`. Removed `confirm-clarifications`.
- **Skills:** removed `mma-clarifications`. Re-installing the skill set actively cleans up orphan skill files.
- **Defaults:** Context-block TTL 30 min absolute → 24 h idle (resets on `get()`); `maxEntries` 100 → 500; HTTP body cap 50 MiB hard `413`.
- **Removed clarification flow** entirely (`ClarificationTool`, `ClarificationToken`, clarification-resume protocol, clarification-pause state, `proposedInterpretation` envelope field).

### Internal changes (no caller impact)

- **Architecture:** restructured into common-library sub-groups + tool slot fillers over a shared framework.
- **Runner substrate:** `RunnerShell` + 3 thin adapters replaces three parallel runner files.
- **Lifecycle:** `StagePlan` declarative + `LifecycleDriver` iterates predicates — no inline branching. `ReworkLoopDriver`, `RequestPipeline`, `AttemptRecorder`, `TelemetryFlushWorker`, `ReadinessClassifier`, `EffortInferer`, `CrossTierGuard` removed (subsumed or unneeded).
- **Reviews:** `ReviewerEngine` (gating reviews) and `AnnotatorEngine` (annotation passes) split.
- **Telemetry:** unified `EventEmitter` → three channels (`CallerResponseChannel`, `VerboseLogChannel`, `TelemetryChannel`). Deprecated-fields constants emitted on the wire for backend back-compat.
- **Tests:** 2506 passing (298 files).

### Backend compatibility

The wire payload remains compatible with the existing telemetry backend. Deprecated fields are emitted as constants for back-compat:
- `capabilities: []`
- `clarificationRequested: false`
- `briefQualityWarningCount: 0`

The wire schema's `triggeringSkill` field is omitted by the daemon (optional in v4 wire schema; daemon never emits it).

## [3.12.7] - 2026-05-04

### Fixed
- **`SEVERITY_RE` and `CLAIM_LABEL_RE` recognize bullet-prefixed lines.** 3.12.6 standardized the read-only-tool implementer prompts to emit findings as Markdown bullets (`- Severity: high`, `- Issue: ...`, `- Suggestion: ...`), but the deterministic extractor's regexes still expected bare label lines (`Severity: high`). Result: live 3.12.6 audit on `goal.md` returned 11 findings (good — extractor found the sections) but ALL classified as `medium` (bad — severity regex didn't match the bulleted lines, defaulted), masking the real distribution (2 high / 5 medium / 4 low). Both regexes now accept optional bullet prefixes (`-`, `*`, `+`) and bold wrappers (`**Severity:**`). Live re-test on the same audit narrative recovers the exact severity breakdown the implementer wrote.

## [3.12.6] - 2026-05-04

### Fixed
- **Standardized findings format across all read-only routes (audit, debug, review, verify) so the deterministic extractor and the LLM reviewer agree on the same single source of truth.** Pre-3.12.6 each executor's prompt described the format informally and the deterministic extractor's `SECTION_RE` only recognized Markdown-heading patterns (`## 1. Title`) — DeepSeek-as-implementer happened to produce bold-numbered findings (`**1.**` on its own line + labeled bullets), which the extractor missed entirely. 3.12.5's transport-failure salvage path then returned 0 findings even when the worker had produced 30 of them. Three coordinated changes:
  - **`SECTION_RE` recognizes both forms** — Markdown headings (`## Finding 1: Title`, `### 2. Title`, `## [3] Title`) AND bold-wrapped numbered headers (`**1.**`, `**Finding 2:** Title`, `**[3]** Title`). Critically, fixed the trailing whitespace bug where `\s*(.*)$` was eating newlines (since `\s` matches `\n` in JS regex), capturing the line BELOW the heading as the title — replaced with `[ \t]*(.*)$`.
  - **`claimFromBody` derives titles from labeled body lines** (`Issue:`, `Title:`, `Summary:`, `Claim:`, `Description:`, `Problem:`, `Finding:`) when the section heading was titleless (the bare `**N.**` form), so dashboard rows show real one-line claims instead of "Finding 1, Finding 2, ...".
  - **All four executor prompts (audit, debug, review, verify) now emit the same canonical `## Finding N: <title>` + bullet-labeled format** with explicit "MUST start with" rules. Both the structured reviewer and the deterministic fallback extract from this format, so a successful reviewer pass and a fallback-after-timeout produce identical structured output. Live test on the goal.md audit narrative (timed out at the 9m+ mark): 30 findings recovered with correct severity rollup (1 critical / 4 high / 8 medium / 17 low) — exactly what the implementer wrote.

## [3.12.5] - 2026-05-04

### Fixed
- **Audit / read-only routes recover findingsBySeverity counts when reviewer transport-fails.** Pre-3.12.5 a reviewer timeout / network error / api error returned `findings: []` and the dashboard's `findingsBySeverity` rolled up to `{critical: 0, high: 0, medium: 0, low: 0}` even when the implementer's narrative contained ~50 real critical/high findings (3.12.4 row 682 was the smoking gun — implementer found dozens of issues, AnnotatorEngine timed out at 120s, structured rollup lost everything). `runAnnotationReview` now runs the deterministic narrative extractor (`fallbackExtractFindings`) on the worker output when the LLM reviewer transport-fails on either attempt. Status still propagates the transport error so operators see the outage in `verdict` / `errorReason`, but `annotatedFindings` carries the structured findings into `concerns` → `event-builder.ts:buildReviewStage` → `findingsBySeverity` rollup → DB column. The synthetic single catch-all from `fallbackExtractFindings` (its no-sections branch) is suppressed by a new `realFindingsFromWorker` wrapper so transport failure on a worker output without numbered sections doesn't fabricate a finding from infrastructure noise. Affects audit, review, verify, debug, explore — every read-only route that uses the AnnotatorEngine path. Tests: 3 in `quality-reviewer-extraction.test.ts` (transport-failure-with-real-narrative, transport-failure-without-structured-content × 2).

## [3.12.4] - 2026-05-04

### Fixed
- **`claude-runner` per-turn usage capture from assistant messages.** Pre-3.12.4 the runner only merged usage from the terminal `result` SDK message — which only fires on conversation completion. Any timeout, mid-stream error, or aborted run left the running `usage` accumulator at zero even after dozens of billable assistant turns, producing telemetry rows with `turnCount: 21, toolCallCount: 12, costUSD: 0, inputTokens: 0` (3.12.3 row 682 was the smoking gun). The runner now extracts `msg.message.usage` (Anthropic API's per-message `usage` field, surfaced by `claude-agent-sdk`) on every `'assistant'`-typed SDK message and merges it into the running accumulator. The `'result'`-message branch now REPLACES the accumulator with its cumulative number when present (preserving the pre-3.12.4 contract for successful runs and avoiding double-counting). Affects every `type: 'claude'` and `type: 'claude-compatible'` provider, including users running DeepSeek through Claude-compatible mode. Test: `claude-runner.test.ts` — *captures per-turn usage from assistant messages so timeouts surface real partial usage*.
- **`openai-runner` HTTP-level usage interceptor for openai-compatible providers.** The `@openai/agents` SDK's stream consumer (`openaiChatCompletionsStreaming.js:38`) overwrites its captured `usage` on every chunk: `usage = chunk.usage || undefined`. For OpenAI proper this is benign, but DeepSeek and similar providers can have intermediate chunks with `usage:undefined` AFTER an earlier chunk reported real numbers, wiping the captured value. New `openai-usage-interceptor.ts` wraps `client.chat.completions.create` at provider construction time, capturing usage from BOTH non-streaming responses and streaming chunks (taking the last seen non-null usage per request). The runner reads from this accumulator as a fallback whenever `state.usage.inputTokens === 0` despite turns having occurred (`openAIUsage` and `partialUsage`). Tests: `openai-usage-interceptor.test.ts` (4 tests covering non-streaming, streaming-with-undefined-chunks, multi-call accumulation, and the zero-token refusal edge case).

## [3.12.3] - 2026-05-04

### Fixed
- **Reviewer never skipped on shared-model + slot-different configs.** `runWithFallback` no longer receives `forbiddenIdentities: [implementerIdentity]` for spec/quality/diff reviewer calls. Slot separation is enforced solely by `forbiddenTiers: [resolved.slot]`. Rationale: if the user has intentionally configured both `standard` and `complex` slots with the same model (or backend), the slot assignment IS the separation contract — refusing to review on identity grounds was unwarranted paternalism. This also unblocks the 3.12.2 case where `canonicalIdentity` could throw on a successfully-constructed provider, fail-closing into `bothUnavailable=true` and silently skipping every spec_review for the affected route.
- **Reviewer 0-cost / findings lost on DeepSeek (and other openai-compatible non-OpenAI providers).** `openai-runner` review-mode no longer returns `status='error'` when `reviewerOutputType.safeParse` fails. Instead it returns `status='ok'` with `parsedFindings: null`, allowing `runAnnotationReview`'s text-parser fallback (`parseReviewerFindings` → `fallbackExtractFindings`) to recover findings from the assistant text. Fixes the 3.12.2 regression where DeepSeek-v4-pro reviewers logged 30 turns + 21 tool calls but recorded `costUSD=0`, `inputTokens=0`, `verdict='error'`, and `findingsBySeverity={...0}` — every audit's quality_review was lost. Resolves the cascading `fallbackCount=1` on 100% of 3.12.2 tasks.
- **`agents.implementer` no longer drifts from stage `agentTier` after fallback.** `agentEnvelope` (`reviewed-lifecycle.ts`) now reports `resolved.slot` as the implementer identity, matching what `stats.implementing.agentTier` records. Per-call slot drift remains visible via `fallbackOverrides` and `implementerHistory`. Pre-3.12.3 used `latestAttemptedImpl.tier`, which silently disagreed with stage stats whenever `runWithFallback` flipped tiers — producing audit telemetry rows where top-level `agentType: standard` contradicted `implementerTier: complex` and the model that actually executed.
- **Review-stage `totalIdleMs` clamped to `durationMs`.** `endReviewStage` now clamps the snapshotted idle accumulator to the stage's wall-clock duration. Pre-3.12.3 saw 110-145% idle ratios on every failed reviewer because `runAnnotationReview` makes 2 sequential `delegateWithEscalation` calls and tail events from cross-runner async cleanup landed after the stage's transition boundary, producing impossible values that broke downstream "% time idle" dashboards.

## [3.12.2] - 2026-05-03

### Added
- **Cost-attribution revamp — pure `priceTokens` function.** New `TokenCounts`, `RateCard`, and `priceTokens` types and function in `packages/core/src/cost/compute.ts` replace scattered, inconsistent pricing logic. Each runner now emits sibling-semantic `CanonicalUsage` where `inputTokens` excludes cached tokens. A single pure `priceTokens(tokenCounts, rateCard)` is the only pricing path.
- **Per-round token snapshots and per-turn delta cost meter.** Lifecycle takes per-round token snapshots so multi-round review/rework stages emit one `StageEntry` per round with accurate per-turn cost deltas instead of stale cumulative totals.
- **Telemetry schema v4 — round, split cached fields, tierUsage.** `StageEntry` gains an optional `round` counter. Cache tokens are split into `cachedReadTokens` and `cachedCreationTokens` across all runner usage shapes. `Event` gains `tierUsage` (per-tier token rollup) and `parentModel` / `parentEquivalentCostUSD`.
- **R6b soft warning when cached >> input.** The event-builder now emits a soft telemetry warning when cached tokens vastly exceed input tokens, flagging potential cache-truncation anomalies.
- **`rollupByTier` and `sumTokens` pure helpers.** New pure aggregation helpers in `packages/core/src/cost/rollup.ts` roll up stage entries by tier and sum token counts.
- **`resolveRateCard` with profile lookup.** Rate-card resolution with per-model-profile pricing and sensible defaults, replacing hard-coded provider price tables.
- **Calibrated Anthropic pricing.** Anthropic profiles updated with `cachedCreation` pricing (USD 1.25/M for Opus 4, USD 0.375/M for Sonnet 4 CACHE_WRITE multiplier).

### Changed
- **Runner usage semantics.** Runners (Claude, OpenAI, Codex) now emit canonical `inputTokens` (excludes cache reads/writes) and separate `cachedReadTokens` / `cachedCreationTokens` fields. Cache read/write costs are additive on top of base input price.
- **Reviewer-implementer separation gated by tier, not model name.** Separation is controlled by `standard` / `complex` / `main` tier membership rather than canonical model-name matching, preserving user sovereignty over model choice.
- **Profile model renamed.** `cachedInput` renamed to `cachedRead` in model profiles; `cachedCreation` added for Anthropic providers that charge for cache writes.
- **Architecture docs.** Added three-axis layered architecture map (horizontal stages, vertical tool stack, substrate) to `docs/ARCHITECTURE.md`.

### Removed
- **Legacy cost helpers.** Deleted `computeCostBreakdown`, `computeCostDeltaVsParentUSD`, `normalizeUsageToSubset`, and the `cachedTokens` field — superseded by the pure `priceTokens` path and split cache fields.

### Fixed
- **Stage telemetry completeness.** Deferred-finalizer pattern ensures `spec_review` and `quality_review` stage entries persist even when rework paths abort early. Diff-review verdict reflects actual lifecycle decisions instead of hard-coded `not_applicable`. Contradictory `terminalStatus` / `errorCode` triples resolved.
- **Schema normalization.** `maxIdleMs` / `totalIdleMs` normalized to integer `0` everywhere. Silent-incomplete runs surfaced via `incomplete_no_summary` error code.
- **`runner_crash` model identity.** Resolved `implementerModel` preserved on `runner_crash` paths instead of emitting `"custom"`.

## [3.12.1] - 2026-05-03

### Fixed
- **Stage telemetry completeness (Items 1, 8).** Deferred-finalizer pattern ensures `spec_review` and `quality_review` stage entries persist even when rework paths abort early (round_cap, cost_ceiling, time_ceiling, all-tiers-unavailable). Guarded `quality_review` `endReviewStage` by `reviewPolicy` so stages are not stamped when review didn't run. Added R16 schema invariant: rework stages imply a preceding review stage on the wire.
- **Diff-review correctness (Items 2, 3).** Plumbed `diffReviewStatus` through `RunResult` → event-builder so `diff_review.verdict` reflects the actual lifecycle decision (approved / changes_required / concerns / error) instead of hard-coded `not_applicable`. Overwrote `terminationReason` on diff_review reject and transport_failure paths so `terminalStatus` and `errorCode` agree (was `ok` + `diff_review_rejected` — a contradictory triple causing event drops).
- **Schema and value normalization (Items 5, 7, 9, 18).** Normalized `maxIdleMs`/`totalIdleMs` to integer `0` everywhere, dropped `.nullable()` on the wire (was mixed `number | null`). Propagated `null` cost from `extractMetrics` instead of collapsing to `0` when pricing is unavailable. Surfaced silent-incomplete runs via `errorCode` (`incomplete_no_summary`) instead of leaving `workerStatus: done` + `errorCode: null`. Preserved resolved `implementerModel` on `runner_crash` paths instead of emitting `"custom"`.
- **Separation and invariants (Items 11, 12, 13).** Reviewer-implementer separation now gated by **tier** (`standard` / `complex` / `main`), not by canonical model name — user is sovereign over model choice; tier is the mechanism gate. R3 schema rule compares `stage.tier === event.implementerTier`. `forbiddenTiers` parameter on `runWithFallback` enforces the gate at all 5 reviewer call sites; `reviewer_separation_unsatisfiable` errorCode surfaces the case where no different-tier reviewer is available. Fixed R4 stage-duration sum invariant (defensive clamping). Attached `validation_warnings` to emitted events (deduped by rule + path) so schema refinement violations are reported, not silently dropped.
- **Runner layer (Items 10, 14, 4).** Normalized token semantics across providers (R6a) — Claude runner constructs `inputTokens = turnInputTokens + cache_read + cache_creation` directly; `runners/base/usage-accumulator.ts` adds `normalizeUsageToSubset` as a safety net. Cost calculation consumes `cachedTokens` AND `reasoningTokens` in all three runners (R6b) so per-stage cost breakdowns reflect the actual cache discount. Reviewer prompts split into `{systemPrefix, userBody}` for cross-runner caching — Claude SDK emits `cache_control: ephemeral` via `cacheHints.cacheableSystemPrompt`; OpenAI/Codex route `systemPrefix` into `Agent.instructions` / Responses `instructionsSuffix` for automatic prefix caching.
- **Intake plumbing (Items 6, 19).** Threaded `verifyCommand` from HTTP brief through `DelegateTaskInput` → `DraftTask` → `resolveDraft` → `TaskSpec` → lifecycle, plus the parallel path via execute-plan's compiler and executor. Closed a four-point gap that silently dropped the field. Threaded `reviewPolicy` and `verifyCommandPresent` through the recorder callback so emitted events carry the caller's actual values; `'off'` and `'spec_only'` normalized to wire-enum values.
- **`committing` stage gating (Item 16).** Emit `committing` stage for both `headMoved` and `treeDirty` paths so execute-plan telemetry shows the commit phase consistently.
- **Schema rename audit (Item 17).** Consumer-side renames in frontend + backend repos: `agentTier 'reasoning'` → `'complex'`; dropped `style` severity bucket; `totalSavedCostUSD` → `costDeltaVsParentUSD` with sign-flip semantics.

### Added
- **`StageEntryBase.tier`** + **`TaskCompletedEventSchema.implementerTier`** — every stage entry carries `tier: 'standard' | 'complex' | 'main'` alongside `model`. Top-level event carries `implementerTier`. Used by R3 (tier-based separation gate) and `forbiddenTiers` reviewer fallback. Model strings remain for cost accounting.
- **R16 cross-field invariant** in `ValidatedTaskCompletedEventSchema` superRefine: `event.stages` containing a `spec_rework` entry implies it must also contain a `spec_review` entry; symmetric for `quality_rework` → `quality_review`. Warn-only per the 3.10.4 contract.
- **`incomplete_no_summary`** and **`reviewer_separation_unsatisfiable`** errorCode values (added to both `ErrorCode` Zod enum and `structuredError.code` union).
- **`validation_warnings`** field on `TaskCompletedEventSchema` — optional array of `{ rule, path }` carrying the issues from both base-schema and cross-field validation, deduped at the recorder.

### Changed
- **`forbiddenModels` → `forbiddenTiers`** in `runWithFallback` parameter shape. Threaded through 5 reviewer call sites in `reviewed-lifecycle.ts`. The `routing/canonical-model.ts` helper is deleted (model strings stay for cost; tier is the gate).
- **`extractMetrics`** in `quality-reviewer.ts` is now exported and returns `costUSD: number | null` (null = pricing unavailable; 0 = free). `addMetrics` preserves partial signal (null + known = known; null + null = null).
- **`deriveErrorCode`** in `event-builder.ts` reads `rr.errorCode` after `rr.structuredError?.code` so top-level errorCode flows through to the wire.

### Tests
- 99 new tests covering the 22 fix items: stage finalizer, diff_review verdict roundtrip, terminationReason on reject/transport_failure, idle-ms normalization, verifyCommand intake, cost-with-cache, runner-crash implementerModel preservation, tier-based separation, R16 invariant, validation_warnings dedupe, reviewer prompt parts split. Full suite: **301 test files / 2786 tests** (up from 2687 baseline). All passing.

## [3.12.0] - 2026-05-02

### Added
- **`/explore` divergent ideation tool** (server + core). New POST `/explore?cwd=<abs>` endpoint that produces 3-5 distinct "threads of thought" from a partial idea, designed to run before `superpowers:brainstorming`. Architecture: three workers under one batch — internal investigator (codebase, readonly), external researcher (web/adapters, no fs), synthesizer (no tools). Internal + external run in parallel; synthesizer composes after. Distinct from `mma-investigate` by output shape: investigate converges to one answer, explore diverges to multiple directions.
- **Runner-uniform research tool surface** (`packages/core/src/runners/base/research-tools.ts`). Six tools — `web_search` (Brave, optional), `web_fetch` (HTTPS-only with SSRF guard, allowlist, IP pinning), `arxiv`, `semantic_scholar`, `github_search`, `rss` — exposed identically across openai / claude / codex via the new `TaskSpec.customToolset` injection field. Adapters call hardcoded HTTPS endpoints; only `web_fetch` is policed by the per-task host allowlist.
- **`ResearchConfigSchema`** (`packages/core/src/config/schema.ts`). Top-level `research` block on `multiModelConfigSchema`: `brave.apiKeys` (round-robin with per-call retry budget + deadline), `fetch` (timeouts, body-size cap, redirect cap, optional `allowPrivateNetwork`), `builtinAdapters` (toggles), `userSources` (free-form text strings), `fetchAllowlistExtra` (canonical IDNA-normalized hosts).
- **SSRF-defense `web_fetch`** (`packages/core/src/research/web-fetch.ts` + `ssrf-guard.ts`). HTTPS-only; rejects IP literals; canonical hostname allowlist (exact match, IDNA-normalized); always-reject set covers loopback / cloud-metadata / link-local / CGNAT (RFC 6598 100.64.0.0/10) / IPv4-mapped IPv6 / 6to4 with embedded-v4 reclassification / multicast; conditional-reject set (RFC 1918 + `fd00::/8`) gated on `allowPrivateNetwork: true` AND provenance `'extra'` (per-task allowlist tracks `Map<host, 'extra' | 'user_source'>` so userSources-derived hosts cannot opt into private-IP fetching).
- **Brave key rotation with leak-proof errors** (`packages/core/src/research/web-search.ts`). In-process atomic counter (try/finally on the lock chain) round-robins keys across calls; per-call retry budget = `min(N_keys, 4)`; overall deadline + jittered exponential backoff; error messages never include the key value (security test pins this).
- **Untrusted-content delimiter wrapping** (`packages/core/src/research/untrusted-content.ts`). `<external-content url=… host=… trustLevel="untrusted">…</external-content>` for fetched HTML; `<external-search-results …>` for Brave results. Worker prompts treat anything inside as data, never instructions; injection-attempt detection surfaces as `injectionDetected: true` on the source row.
- **`mma-explore` SKILL** (`packages/server/src/skills/mma-explore/SKILL.md`). Output-shape disambiguation at the top of "When to Use": one answer → `mma-investigate`; multiple directions → continue. Cross-link added to `mma-investigate/SKILL.md` "Don't use when…" list.
- **Six observability events** (`packages/core/src/observability/events.ts`): `explore.task.start/end`, `explore.brave.attempt`, `explore.adapter.call`, `explore.source.skipped`, `explore.fetch.blocked` — schemas pinned in `EventSchemas`, contract-tested under `tests/contract/observability/explore-events.test.ts`.
- **Partial-failure synth handoff.** When one of internal/external workers fails, synthesizer still runs with a fixed stub for the failed side; envelope flags `degradedSources`. When both fail, synthesizer is skipped (`qualityReviewVerdict: 'skipped'`, reason `no_synth_input`). When synthesizer itself fails after both workers succeed, both worker outputs are preserved on the envelope; caller can re-dispatch synthesis only via `mma-retry` on `taskIndex=2`.
- **Source adapters**: arxiv (Atom feed parser, case-insensitive http→https rewrite), semantic-scholar (JSON), github-search (code + repo), generic-rss (RSS 2.0 / Atom / RSS 1.0/RDF, consumes `WebFetchResult.rawText` to avoid escaped-XML breakage). Generic-rss adapter skips parsing when `textTruncated: true` to avoid silently-incomplete bodies.
- **Markdown→threads parser** (`packages/core/src/reporting/parse-explore-report.ts`). Per spec §4.2.4: contiguous numbering (renumbers on gaps + flags `malformed_threads`), duplicate-number dedupe, duplicate-axis dedupe, sentinel handling, ≤5 thread cap, `extractionDiagnostics.droppedThreads[]` for missing-required-field drops.
- **`IncompleteReason: 'threads_dropped'`** distinct from `'malformed_threads'` so downstream consumers can tell "format was broken" from "individual threads were invalid but structure was OK".
- **`@types/jsdom`** devDep + `@mozilla/readability` + `fast-xml-parser` runtime deps for HTML main-text extraction and feed parsing.

### Changed
- **`TaskSpec.tools` is unchanged** but a new optional `customToolset?: ResearchToolDefinition[]` field flows through to runner adapters (openai / claude / codex). All three runners merge the array into the worker's tool surface when `tools === 'none'`. All other executors leave the field undefined; runners treat `undefined` as a no-op.
- **`ReadOnlyReviewFlag` route enum extended** with `'explore'` so `MMAGENT_READ_ONLY_REVIEW=explore` enables quality-only review for the new route.
- **`undici 8` `request()` no longer accepts `maxRedirections`** — adapters and `web_fetch` removed the parameter (default is no auto-redirect; `web_fetch` follows redirects manually with per-hop allowlist re-validation).
- **OpenAPI doc + golden + route enum** include `/explore`; total path count is now 15 (8 tool routes + 4 control + 2 introspection + 1 OpenAPI introspection).

### Tests
- 411 new tests across the explore subsystem: 17 allowlist + 59 ssrf-guard + 31 web-fetch security + 20 web-fetch happy-path + 16 + 4 web-search + 4 untrusted-content + per-adapter (arxiv / semantic-scholar / github-search / rss) + 26 reviewed-execution explore + 21 executor unit + contract tests for skill manifest, observability event schemas, and the routes manifest. Full suite: 2687 passing.

## [3.11.1] - 2026-05-02

### Fixed
- **Stuck telemetry queues with rotated installIds self-heal.** The flusher now drops a contiguous head-prefix of records whose `installId` doesn't match the current local identity, in addition to the existing `schemaVersion < SCHEMA_VERSION` legacy-record drop. After `mma telemetry reset-id` (or any other rotation), the next flush drops the orphaned records locally without a network round-trip — they were permanently un-authenticatable anyway. The per-flush `getOrCreateIdentity(...)` snapshot is now threaded into `#uploadBatch` as a parameter so the head-truncation predicate and the upload signing share one identity read. (Bug 1)
- **Exponential backoff actually doubles.** `Flusher.#scheduleBackoff` no longer resets `#backoffMs` (either via the `clearBackoff()` call at entry or the `this.#backoffMs = 0` inside the timer callback). Consecutive failures now retry at `5 → 10 → 20 → 40 → 60`-min cap, dropping backend load from a flat **12 req/hr** to **~1 req/hr** at steady-state for any stuck install. Every "no upload work to do" terminal path in `#doFlush` calls `clearBackoff()` to keep the contract crisp: `#backoffMs > 0` only while ≥ 1 record is actually stuck on a transient failure. (Bug 2)
- **`claude-agent-sdk` 0.2.113+ subprocess `env` no longer drops `PATH`/`HOME`/proxy vars.** The claude-runner's per-invocation `Options.env` block now spreads `...process.env` first so the spawned Claude subprocess inherits the full environment. The next routine `npm install` will resolve `^0.2.112` → `0.2.126`; the 0.2.113 release flipped `Options.env` semantics from "merge on top of `process.env`" to "replace `process.env`", which without this fix would silently strip subprocess env on every `claude-compatible` provider (DeepSeek, OpenRouter, etc.). (Bug 3)
- **OpenAI reviewer findings preserve their assigned severity end-to-end.** Replaced the OpenAI runner's JSON-block extraction with `Agent.outputType: z.object({ findings: z.array(reviewerEmittedFindingSchema) }).strict()` (Structured Outputs API). `RunResult.parsedFindings: AnnotatedFinding[] | null` is now a **required** field; the quality-reviewer's `CallOk` wrapper threads it through and prefers it over `parseReviewerFindings(...)` when non-null. Reviewer-emitted critical / high / medium / low severities round-trip without collapsing to `medium` via the JSON-parse fallback. Claude and Codex paths unchanged (their SDKs lack an equivalent typed-output API). (Bug 4)
- **Severity vocabulary locked to 4-tier `{critical, high, medium, low}`.** Widened `DiffReviewConcern.severity` from 3-tier to 4-tier; corrected a stale `'major' | 'minor'` doc comment on `RawConcern.severity`. New contract test `tests/telemetry/severity-vocabulary.test.ts` fails CI if a future PR adds, removes, or renames a tier across `SeverityBin`, `annotatedFindingSchema`, or `reviewerEmittedFindingSchema`. (Bug 5)
- **Fallback-unavailable no longer wipes accumulated implementer work.** Demonstrated case: a 56-min / 444-turn / 73-file-written implementer run was being recorded as `duration_ms=2`, `turns=1`, `tokens=0`, `cost=0`, `stages=[]`, `implementer_model='custom'` after both standard and complex tiers transport-failed. `runWithFallback` now returns a `salvageResult: T | null` carrying the higher-work-score of the two attempts; `adaptForAllTiersUnavailable(...)` consumes that salvage to finalize the implementing stage and threads the resolved config model onto `RunResult.models.implementer`. The R2.1 cross-field validator is unchanged — the fix populates stages, not the allow-list. (Bug 6)
- **`mmagent serve` survives a closed parent stdio pipe.** `startServe(...)` now installs `process.stdout.on('error')`, `process.stderr.on('error')`, `process.on('uncaughtException')`, and `process.on('unhandledRejection')` listeners. EPIPE-coded errors call `exit(0)` (consumer is gone, server has nowhere to log to and no consumer for HTTP responses); all other errors call `exit(1)` after best-effort diagnostic emission. Each listener routes its `ShutdownCause` (`'stdout_epipe'` / `'stdout_other_error'` / `'uncaughtException'` / `'unhandledRejection'`) through a `logShutdown(cause)` helper — a documented no-op today (no `RunningServer.diagnostics` surface yet) that gives a one-line uplift point when one is added. Listeners are removed in `stop()` so in-process test boots don't accumulate them. (Bug 7)

### Tests
- 16 new tests across the seven bugs (severity vocabulary contract, claude env spread, serve crash guards, fallback-unavailable preservation, OpenAI typed reviewer round-trip, and seven flusher behavior tests for Edits A/B/C). All 2276 tests pass.

## [3.11.0] - 2026-05-02

### Fixed
- **Reviewer cwd plumbing** (runtime, R3 quality killer). Quality / spec / diff reviewers fell back to `process.cwd()` of `mmagent serve` instead of `task.cwd` when they landed on a different runner from the implementer. Every reviewer fallback call now plumbs `task.cwd` into `provider.run` options across all three runners (codex, claude, openai). New `tests/contract/reviewer-cwd.test.ts` pins the contract.
- **Reviewer-separation fallback violated R3** (escalation). When the assigned reviewer tier transport-failed, the fallback could land on the implementer's own model (same identity → review self-confirms). New `forbiddenIdentities` parameter on `runWithFallback` compares the candidate's resolved canonical identity tuple `(providerType, normalizedEndpoint, modelId)` against the implementer's identity; fails closed if identity unresolvable on a constructed provider. New `'reviewer_unavailable_separation'` error code when no candidate respects separation.
- **`force_salvage` watchdog removed** (runtime, §3.7). The 95% `softLimit` `force_salvage` path force-terminated genuinely thorough work based on input-token volume — an arbitrary internal cap that contradicted the user's "thoroughness pays" stance. Removed across all three runners. The 80% warning-nudge injection also removed (redundant given user-set `maxCostUSD` / `timeoutMs` hard backstops). Provider context-window failures now classify as `provider_context_limit` (distinct from `incomplete` / `budget_exceeded`).
- **Negative `read_only_review.quality.cost_usd`** (telemetry, §3.9). The review-cost emission path mixed up actual-cost with delta-vs-parent, producing negative numbers in real-world telemetry. Diagnosed and fixed; runtime monotonic-cost invariant assertion in dev/test catches future regressions.
- **`wallClockMs: 0` hardcoded on single-task paths** (telemetry, §3.1). audit / debug / execute-plan single-task return paths emitted `wallClockMs: 0` instead of `Date.now() - startMs`. Real wall-clock now reported.
- **Tier vocabulary drift between column and payload** (telemetry, §3.2). `agentTier` was emitted as `complex` in the top-level column but translated to `reasoning` in the stage payload. Removed translation; canonical `'standard' | 'complex'` everywhere.
- **Negative `costDeltaVsParentUSD` from formula+rename mismatch** (telemetry, §3.3). `computeSavedCostUSD` renamed to `computeCostDeltaVsParentUSD` AND formula flipped to `actualCostUSD - parentCost`. Positive = worker more expensive than parent; negative = worker cheaper. Honest-`null` when any required token dimension is unavailable.
- **Concern classifier collapsed audit findings to `"other"`** (telemetry, §3.4). Source-code-review patterns missed audit-domain vocabulary. Added `doc_drift`, `contract_violation`, `coverage_gap`, `dead_code`, `queue_hygiene` categories.
- **Dead `style` severity bucket + dead `findingsFlagged` / `severityCorrections` fields** (telemetry, §3.5 + §3.10). `findingsBySeverity` is now the documented 4 tiers (critical / high / medium / low); legacy zero-stub fields removed entirely per `rules/development-mode.md`.
- **`proposedInterpretation` was `not_applicable` while clarifications pending** (envelope contract, §5.1). Per the public 7-field envelope contract, a string `proposedInterpretation` IS the awaiting-clarification gate. `executeDelegate` now synthesizes a non-empty interpretation from the first clarification when one is pending; runtime invariant assertion in dev/test prevents the regression.

### Added
- **Per-route prompt scope contracts** (intake, §6.1). Each route's compiler now appends a scope-contract clause to the worker's prompt: audit ("Do NOT enumerate the repository"), review ("Do NOT review code outside the requested scope"), verify ("Do NOT explore or refactor"), debug ("Reproduce the failure first"), delegate ("Stay scoped to the explicit task description"), execute-plan ("Execute exactly the steps in the plan"). New `tests/behavioral/audit-prompt-scope.test.ts` uses a deterministic mock runner to assert the audit prompt blocks repo-wide globs.
- **Approximate-budget semantics for `maxCostUSD` / `timeoutMs`** (config, §3.8). Both are documented as approximate budgets, not strict caps — the runtime aborts at 0.80 × the cap (named via `MAX_COST_HEADROOM_RATIO` / `MAX_TIME_HEADROOM_RATIO` constants) to leave headroom for one in-flight turn. Worst-case overshoot calculation documented in API docs and every route's SKILL.md. Defaults exported as named constants: `DEFAULT_TASK_TIMEOUT_MS = 1h`, `DEFAULT_STALL_TIMEOUT_MS = 20min`, `DEFAULT_MAX_COST_USD = $10`. New `time_ceiling` abort path mirrors the cost-ceiling path at both lifecycle and runner levels.
- **Cached and reasoning tokens on every runner** (telemetry, §3.6). New `runners/base/usage-accumulator.ts` defines `CanonicalUsage` with `cachedTokens` and `reasoningTokens` as `number | null` (null = provider doesn't expose; number = real value, including 0). codex / openai map `cached_input_tokens` and `reasoning_tokens` directly; claude sums `cache_read_input_tokens + cache_creation_input_tokens` into `cachedTokens` (reasoning stays null per claude API gap).
- **Telemetry coverage invariant** (testing, §3.11). `tests/telemetry/coverage.test.ts` asserts every event in `observability/events.ts` has a runtime fixture (or is in `UNCOVERED_ALLOWLIST` with reason). Emit-time schema validation in dev/test (throws on violation) replaces silent acceptance.
- **`__forceClarification` test seam** (intake, §5.2). Gated by `NODE_ENV === 'test' AND MMAGENT_TEST_SEAMS === '1'` (double-gating prevents accidental fires). Pairs with `__clearForcedClarification()`. Request-scoped via `Map<batchId, reason>` plus a global one-shot via `__forceClarificationGlobal`. Cross-process via `MMAGENT_FORCED_CLARIFICATION` env var. New `tests/contract/http/confirm-clarifications.test.ts` re-authors the full HTTP round-trip; `tests/contract/lifecycle.test.ts` re-authors clarification-precedence.
- **Cross-runner consistency contract test** (testing, §11). `tests/contract/cross-runner-consistency.test.ts` asserts an invariant subset (event-type set, `terminationReason` enum, `RunnerOptions.cwd` honoring, per-stage telemetry shape, no-watchdog regression, `provider_context_limit` classification) — uniformly across codex / claude / openai. Any future runner-layer fix that fails to update all three runners fails this contract.

### Changed
- **Breaking telemetry payload changes.** Field renames (`savedCostUSD` → `costDeltaVsParentUSD`; `agentTier` translation removed), removed fields (`style` severity, `findingsFlagged`, `severityCorrections`), nullable shape changes (`cachedTokens`, `reasoningTokens` are `number | null`), removed event types (`watchdog_force_salvage`, `watchdog_warning`). Frontend ingest must align with the new shapes.

See `docs/superpowers/specs/2026-05-01-mma-runtime-and-telemetry-fixes-design.md` for the complete design.

## [3.10.7] - 2026-05-01

### Fixed
- **Telemetry queue head-of-line block on legacy-schema records** (server, critical hotfix). Records with `schemaVersion < SCHEMA_VERSION` (V1 / V2) used the older wrapper shape with `installId` nested under `body.install.installId`. The current backend `verify-signature` middleware reads `body.installId` at top level (V3-only) and returns **401 `install_id_mismatch`** for legacy payloads — non-droppable in the flusher's `204/400/413` ack contract, so legacy records sat at the queue head forever, and every newer V3 record behind them never reached the wire. Real-world impact: users upgraded across a schema bump saw a continuous stream of 401s on `/v1/events` every 5 minutes and `~/.multi-model/telemetry-queue.ndjson` grew without ever draining. Fix: at the start of each flush, detect a contiguous prefix of records with `schemaVersion < SCHEMA_VERSION`, truncate them locally via the existing `queue.truncate(meta)` path, then re-read so byte offsets reflect the new file layout. Self-heals every existing user's stuck queue at the next flush — no backend deploy, no manual queue surgery, no user action required beyond upgrading.

## [3.10.6] - 2026-05-01

### Fixed
- **Skill docs misrepresented agentType / effort routing** (skills, doc rot). The router skill (`multi-model-agent/SKILL.md`) claimed `mma-execute-plan` accepts `agentType` (false — schema is `.strict()` and rejects with HTTP 400; `executors/execute-plan.ts:104` hardcodes `'standard'`) and that `mma-verify` defaults to `standard` (false — `executors/verify.ts:89` hardcodes `'complex'`). `mma-execute-plan/SKILL.md` claimed worker tier was "set by the plan and per-route defaults" (false — locked to `standard` regardless of plan content). Real-world impact: callers reading the docs would write `agentType: 'complex'` into `/execute-plan` requests and get 400s, then fall back to `mma-delegate` without understanding why.

### Changed
- **Router skill rewritten with accurate tier table** (skills). `multi-model-agent/SKILL.md` now states only `mma-delegate` accepts `agentType` per task, and gives a complete table of every other route's hardcoded tier (`/execute-plan` → `standard`; `/audit`, `/review`, `/debug`, `/verify`, `/investigate` → `complex`). Recommended escalation path documented: dispatch via `mma-delegate` with the plan task as the prompt and `agentType: 'complex'` when `complex` tier is needed for plan-style work.
- **Per-route SKILL.md tier disclosures** (skills). Added a one-line "Worker tier hardcoded; `agentType` rejected with HTTP 400" note to `mma-audit`, `mma-review`, `mma-debug`, `mma-verify`, matching the precedent already in `mma-investigate`. Each per-route skill is now self-sufficient — readers don't need to cross-reference the router skill to learn that tier is fixed.

### Added
- **"Reasoning effort: auto-inferred" section in router skill** (skills, previously undocumented behavior). Documents `inferEffort()` heuristics from `effort-inference.ts:11-25`: code block > 20 lines → `low`, file path + action verb (`edit|modify|update|fix|refactor|replace`) → `medium`, otherwise provider default. Effort is auto-routed independently of tier and is not caller-overridable from any `mma-*` skill — surfacing this lets callers reason about why the same prompt rephrasing produces different worker behavior.

## [3.10.5] - 2026-05-01

### Fixed
- **Read-only audits silently failed quality review** (core, critical bug fix). The 5 read-only routes (audit / review / verify / debug / investigate) advertised a `findings[]` JSON contract via `intake/resolve.ts:OUTPUT_CONTRACT_CLAUSES`, but four of the five executors (`executors/audit.ts`, `executors/review.ts`, `executors/verify.ts`, `executors/debug.ts`) built worker prompts inline and bypassed both the intake pipeline and the manual clause-inlining that `compileInvestigate` did. The worker was never told to emit JSON; the reviewer's `extractWorkerFindings` then parsed nothing and returned `qualityReviewVerdict: 'error'` — every audit/review/verify/debug call routed through gpt-5.5/codex degraded to verdict=error with `findings_reviewed=0`, regardless of how good the worker's narrative was. Real-world impact: $0.30+ audits returning "error" with rich markdown findings sitting unparsed in `result.output`.

### Changed
- **Worker emits free-form narrative; reviewer extracts and scores findings in one pass** (core, breaking for read-only-route consumers — but the path was already broken). New architecture: implementer produces a numbered narrative report tagged with `Severity: critical | high | medium | low`. The reviewer reads the narrative, extracts every distinct issue, normalizes severity to 4-tier, scores `reviewerConfidence` (0–100), and emits one fenced JSON `AnnotatedFinding[]` block. The reviewer is now the sole producer of structured findings — workers never serialize. New files: `packages/core/src/review/parse-reviewer-findings.ts` (permissive fence regex, single-pass extract, `evidenceGrounded` substring annotation, never drops findings) and `packages/core/src/review/fallback-extraction.ts` (deterministic regex fallback for #{2,6}-numbered headings, `[N]` brackets, `Severity: X` lines, "no findings" detection).
- **Always succeeds**: `runAnnotationReview` now retries on parse failure (one round, with stricter "JSON ONLY" reminder). After two parse failures, deterministic regex fallback synthesizes `AnnotatedFinding[]` from the worker's numbered sections so V3 `findingsBySeverity` always has counts to roll up — `reviewerConfidence: null` flags fallback findings. Verdict stays `'annotated'`. Transport failures (network/timeout/api_error) on retry propagate as error so ops outages remain visible.
- **`AnnotatedFinding` schema collapse** (core, breaking — read-only routes). `WorkerFinding` deleted. Single `AnnotatedFinding` shape: `{id, severity, claim, evidence, suggestion?, reviewerConfidence: number | null, evidenceGrounded: boolean}`. **`reviewerSeverity` field removed** — `severity` is the reviewer's authoritative final value (workers' severity is a hint, not a separate field). `id` is reviewer-assigned sequential `F1`, `F2`, ... — no cross-call id-permutation.

### Added
- **`critical` severity tier** (core, V3 telemetry, additive). `SeverityBin` extended from `{high, medium, low, style}` → `{critical, high, medium, low, style}`. `FindingsBySeveritySchema` adds `critical: z.number().int().min(0).max(200)`. **Per-bin cap raised from 50 → 200** so single-pass audits with many findings of one severity no longer silently clamp at 50. Event-builder accumulator clamp follows.
- **`evidenceGrounded` soft trust signal** (core). Each finding gets `evidenceGrounded: boolean` — true when reviewer's quote (whitespace-normalized) appears as a substring of the worker's output. Never drops findings; main agent / dashboard renders ungrounded ones as "lower trust" but always shows them. Anti-hallucination guard without silent data loss.
- **Annotated findings funnel into V3 `concerns[]`** (lifecycle). After the per-event `read_only_review.quality` emit, `finalImplResult.concerns` is mutated with one entry per annotated finding (source: `quality_review`, severity: 4-tier). V3 `findingsBySeverity` rolls them up at task completion, so the dashboard sees real per-tier counts for read-only routes.

### Removed
- **Worker `findings[]` JSON contract** for the 5 read-only routes (`intake/resolve.ts:OUTPUT_CONTRACT_CLAUSES`). The clause is no longer registered for `audit_document`, `review_code`, `verify_work`, `debug_task`, or `investigate_codebase`. `execute_plan` still has its narrative contract.
- **`reviewerSeverity` field** on `AnnotatedFinding`. Severity is reviewer-authoritative; no separate worker-severity field.
- **`extractWorkerFindings` and `parseAndMergeAnnotations`** helpers (`review/quality-reviewer.ts`). Replaced by `parseReviewerFindings` (no id-permutation merge required since reviewer assigns ids fresh).

### BREAKING
- **`AnnotatedFinding` shape changed**: `reviewerSeverity` removed, `evidenceGrounded` added (required), `reviewerConfidence` becomes `number | null`. Consumers reading `result.annotatedFindings[*]` from `/audit`, `/review`, `/verify`, `/debug`, `/investigate` must update.
- **V3 `findingsBySeverity` adds `critical` field** with per-bin cap raised to 200. Telemetry consumers that hardcoded the 4-key shape `{high, medium, low, style}` need to add `critical`. Per-bin cap of 50 was raised to 200; consumers asserting "≤ 50" will need to relax.
- **Worker output for read-only routes is now narrative-only.** Any external tooling that grep'd for `\`\`\`json findings[]` blocks in worker output will find nothing. Findings live in `result.annotatedFindings`, sourced from the reviewer.

## [3.10.4] - 2026-05-01

### Fixed
- **Review stages recorded the wrong agent's model** (core, R3 violation root cause). `endReviewStage` was always called with `implementerAgentInfo`, so `spec_review.model`, `quality_review.model`, and `diff_review.model` always equaled `implementerModel`. R3 (V3 spec: review.model MUST differ from implementerModel) then fired by construction for every reviewed task, regardless of config. Even with a correctly cross-tier setup (e.g. standard=deepseek-v4-pro + complex=gpt-5.5/codex) where the reviewer ran on gpt-5.5, the stage stat recorded deepseek-v4-pro. Fix: build `reviewerAgentInfoFor(tier)` from the actually-resolved provider per tier, and pass the *last-used* reviewer tier (from `specReviewerHistory` / `qualityReviewerHistory`, reflecting any escalation) to `endReviewStage`. 24 contract goldens regenerated.

### Changed
- **Telemetry validation is now warn-only** (server, recorder.ts). 3.10.3 still dropped events that failed the BASE schema (caps/types/enums). 3.10.4 NEVER drops — both base-schema and cross-field violations log a warning and the event still ships. Backend uses `passthrough` so degenerate rows store either way; dropping at the daemon means data is lost forever with no visibility. **Cross-field warnings now include the offending values** (`implementerModel`, per-stage `model` map, top-level totals) alongside the rule name, so the operator can tell at a glance whether the cause is their config or a lifecycle bug — like the R3 case above where the rule name pointed at config but the bug was in our code.

## [3.10.3] - 2026-05-01

### Fixed
- **R4 violation drops every event** (core, critical hotfix). 3.10.2 shipped strict V3 superRefine enforcement at emit time, which exposed a measurement-precision bug: `runResult.durationMs` and per-stage `durationMs` are sampled at different `Date.now()` ticks, so a stage measurement can land 1ms longer than the task-level total. R4 (`Σ stage.durationMs ≤ totalDurationMs`) was then violated by 1ms and **every emitted event got dropped client-side** with `telemetry.event.invalid`. Net effect since 3.10.2: real-world telemetry was silently going nowhere. Fix: `totalDurationMs = max(runResult.durationMs, Σ stage.durationMs)` enforces R4 by construction. Includes a regression test reproducing the production case.
- **Reverted strict drop-on-superRefine emit gate** (server). 3.10.2's `recordTaskCompleted` dropped any event that failed the V3 cross-field rules. In practice this hid real telemetry from the operator AND the backend (which uses `passthrough` and would store it anyway), with no visibility into what was suppressed. New policy: schema-level violations (caps, types, enums — the things backend ingest would actually reject) still drop with a `mma-telemetry: dropping schema-invalid event` warning. Cross-field superRefine violations (R1–R11) now log a `mma-telemetry: cross-field validation warning (event still emitted)` line and the event is shipped. Degenerate rows are filterable at query time on the dashboard side.

### Added
- **Skill manifest backfill on upgrade** (server). When mma is upgraded to a version with newly-bundled skills (e.g. `mma-investigate` added in v3.4.0), `mmagent serve` (with `autoUpdateSkills=true`) and `mmagent update-skills` now install missing skills to whatever client targets the user already opted into. Closes the bug where users on pre-v3.4.0 installs upgraded to v3.9+ and never saw `mma-investigate` registered with their client harness. Skill installation flow is now upsert: existing skills get version-refresh, missing skills get backfilled. Empty-manifest gate prevents push to users who never opted in. Target-scoping prevents widening to clients the user never used.
- **Live-elapsed polling headlines** (server). `GET /batch/:id` 202 responses now compose elapsed time at request time (`Date.now() - dispatchedAt`) rather than reading the frozen string set at the last 5s heartbeat tick. Polling at 1-2s intervals no longer shows the same `— 10s` twice in a row. The `runningHeadline: string` field on `BatchEntry` is replaced with `runningHeadlineSnapshot: HeadlineSnapshot` ({prefix, statsClause, dispatchedAt, fallback}). Stats clause is suppressed when all activity counters are zero.
- **Tiered server stdout** (server). Default `mmagent serve` is now quiet — only stage transitions, dispatch/request metadata, warnings, errors, and a one-line `task_done_summary` per task. `--verbose` keeps the previous firehose, with two corrections: (a) heartbeats are dedup-throttled (emit only on counter change OR every 60s for liveness, with `Number.isFinite` guard on the cost bucket), (b) the inline `stages={...}` JSON on `task_completed` is replaced with `stages_json=<jsonl-path>` pointing at the diagnostic file. The `task_done_summary` event always fires exactly once per task (try/catch + `summaryEmitted` flag covers failure paths). Verbose `task_completed` and `task_done_summary` derive from the same `TaskCompletionSummary` so their numeric fields cannot disagree.
- **Shared helpers** (core). `derive-terminal-status.ts` and `clamp.ts` extracted from `event-builder.ts` so `task-completion-summary.ts` and the event builder share identical clamp/round/derivation rules (no drift between the in-process summary and the wire event).

### Changed
- **`runningHeadline` → `runningHeadlineSnapshot`** on `BatchEntry` (core, breaking only for direct BatchRegistry consumers — no public-API change). The polling endpoint composes the headline string from the snapshot at request time.

## [3.10.2] - 2026-05-01

### Fixed
- **Top-level token/cost totals now sum every stage** (core). Pre-3.10.2, `inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`, and `totalCostUSD` on V3 events were sourced from `runResult.usage`, which only carries the LAST implementer attempt — losing reviewer cost and earlier-impl rounds entirely. Real-world delegate-with-rework batches were under-reporting cost ~24×. Top-level totals now compute as `stages.reduce(...)`.
- **Rework stages appear in `stages[]`** (core). `spec_rework` / `quality_rework` entries previously stayed at `entered:false` even when the rework loop ran — silently dropping the entry from the V3 wire payload. New `endReworkStage` / `accumulateReworkIteration` / `commitReworkStage` helpers aggregate metrics across iterations into a single stage entry per the V3 spec's R9 invariant (stage-name uniqueness).
- **Per-stage `roundsUsed` off-by-one** (core). `endReviewStage` was passed `specAttemptIndex - 1` and `qualityAttemptIndex - 1`, dropping the count by one. The wire `reviewRounds` was already correct via `rr.reviewRounds`; only the in-memory `runResult.stageStats.{review}.roundsUsed` was wrong. 24 contract goldens regenerated.
- **`committing.filesCommittedCount` is wired** (core). Pre-3.10.2 always 0 — `runResult.commits[]` carried `filesChanged: string[]` but `buildCommitStage` ignored it. Now counts unique files across all commits, defensive against malformed input (non-array `commits`, missing `filesChanged`, non-string entries), clamped to schema max 1000. `committing.branchCreated` deferred to 3.10.3 (no reliable signal — branch-name diff produces false positives).

### Added
- **Per-stage and top-level value clamping** (core). `extractStageData` clamps every numeric field to its V3 schema cap (turnCount→250, durationMs→3.6M ms, costUSD→100, tokens→5M/500K caps, toolCallCount/filesReadCount/filesWrittenCount→5000). Top-level totals also clamp at the wire bounds (totalCostUSD→800, tokens→5M/500K, totalDurationMs→86.4M). Real-world long-running tasks no longer fail server-side schema validation by exceeding caps; tests assert exact ceiling values, not loose `<= max`.
- **V3 schema validation enforced at emit time** (core, server). `ValidatedTaskCompletedEventSchema.safeParse` now runs on every constructed `task.completed` event before queueing for upload. Events that violate R1–R11 superRefine rules (e.g. R3: review.model identical to implementerModel — observed in real 3.10.1 audit data) are dropped client-side with a `telemetry.event.invalid` diagnostic, instead of silently shipping degenerate rows to the backend via passthrough. R3 was previously a comment in the validator; now an enforced rule.
- **`field-coverage.ts` manifest** (core). Machine-readable classification of every V3 event field as `derived` / `constant` / `unavailable` / `not_applicable`. Replaces the inline-comment audit pass that earlier proposals considered, with an executable contract that the new completeness ratchet test enforces.
- **V3 completeness contract test** (tests). New `tests/contract/telemetry/v3-completeness.test.ts` plus rich-fixture asserts every derived field on the rich `RunResult` produces a non-default value, every clamp hits its exact ceiling on oversized inputs, and the resulting event passes `ValidatedTaskCompletedEventSchema.safeParse`.

### Changed
- **R5 super-refine relaxed** from strict equality (`Σ stage.X === top-level X`) to `top-level ≤ Σ stage.X` (core, schema). Required because per-stage and top-level schema caps don't compose: 8 stages × 5M token cap = 40M, while top-level cap is 5M. Strict equality cannot hold when stage sum exceeds top cap. The relaxation preserves R5's intent (no daemon-overhead leakage to top) while tolerating realistic clamp behavior.

## [3.10.1] - 2026-05-01

### Fixed
- **top-level token/cost totals (core).** `inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`, and `totalCostUSD` on V3 `task.completed` events were always 0. The builder summed across stages, but `extractStageData()` hardcoded every per-stage token field to 0, so the top-level totals collapsed to 0 in the wire payload. Now read directly from `runResult.usage` — the same source `totalSavedCostUSD` already used.
- **per-stage telemetry metrics (core).** Stage objects in `stages[]` carried 0 for `inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`, `turnCount`, `toolCallCount`, `filesReadCount`, and `filesWrittenCount`. `BaseStageStats` now defines these fields; `endBaseStage` / `endReviewStage` accept a metrics object populated from the implementer's `runResult.usage`/`turns`/`toolCalls`/`filesRead`/`filesWritten` and from the new `SpecReviewMetrics`/`QualityReviewMetrics` returned by `runSpecReview` / `runQualityReview`.
- **negative per-stage cost (core).** Review-stage `costUSD` was computed via `runningCostUSD()` delta, which races with the heartbeat's running-cost update across runners and could go negative. The fix takes per-stage `costUSD` straight from the runner's `usage.costUSD` and clamps the wire value at ≥0. Falls back to the cost-meter delta when the runner does not report `usage.costUSD` (preserves cost telemetry for runners without per-call pricing).
- **`BuildContext.route` (core, type-only).** Union now includes `'investigate'`. The wire schema and runtime path already accepted it; the type was incidentally missing the variant. Tightening the type catches future investigate-route callers at compile time.
- **contract goldens regenerated.** All 33 endpoint goldens updated to reflect the new per-stage metric fields.

## [3.10.0] - 2026-04-29

### Added
- **V3 telemetry schema (core).** `SCHEMA_VERSION` bumped to 3. New wire format with exact integer/numeric fields replacing bucket-based approximations: `totalDurationMs`, `totalCostUSD`, `totalSavedCostUSD`, per-stage `maxIdleMs`/`totalIdleMs`, top-level `taskMaxIdleMs`, `stallCount`, `sandboxViolationCount`, `briefQualityWarningCount`. Stage entries are a discriminated-union array (`stages[]`) replacing the fixed-key stage map. Batch wrapper carries `installId`/`mmagentVersion`/`os`/`nodeMajor` inline (no separate session/install/skill events).
- **33-family model profile registry (core).** `model-profiles.json` expanded to cover all 33 model families: claude, openai, gemini, deepseek, llama, mistral, qwen, grok, cohere, phi, gemma, yi, kimi, sonar, nova, glm, minimax, jamba, granite, nemotron, dbrx, arctic, reka, olmo, hermes, wizardlm, starcoder, dolphin, openchat, vicuna, internlm, baichuan, other. Every profile carries a `family` field; new optional pricing fields `cachedInputCostPerMTok` and `reasoningCostPerMTok` with documented 10%-of-input-rate fallback for cache and output-rate fallback for reasoning.
- **Model normalization (core).** `extractCanonicalModelName` rewrites vendor-prefix stripping with a 5-step algorithm (namespace strip → variant-preserving match → trailing-marker strip → longest-prefix match → fallback). `normalizeModel()` in `telemetry/normalize.ts` returns `{ canonical, family }` from a single call. `deriveModelFamily` and hardcoded `FAMILY_MAP` deleted.
- **Cost compute V3 formula (core).** `computeCostUSD` now uses the 4-term formula: `(input - cached) × inputRate + cached × cachedRate + (output - reasoning) × outputRate + reasoning × reasoningRate`, with subset semantics (reasoning ⊆ output, cached ⊆ input). `computeCostBreakdown` returns per-bucket object.
- **V3 contract goldens (tests).** 16 V3 envelope contract tests covering delegate, audit, review, verify, debug, investigate, execute-plan, retry routes and all terminal statuses, validated against `ValidatedTaskCompletedEventSchema` with R1–R15 superRefine rules.
- **CLI consent re-confirmation (server).** V2 opt-ins do not auto-migrate to V3. On first daemon start after upgrade, `consentSchemaVersion < 3` clears the telemetry flag and prints a notice. `mmagent telemetry enable` now writes `consentSchemaVersion: 3` atomically.

### Changed
- **Event builder rewritten for V3 (core).** `buildTaskCompletedEvent` now emits V3-shaped events: stages array with discriminated-union entries, exact integer/numeric fields, `reviewPolicy`/`verifyCommandPresent`/`parentModelFamily` wired from task context. Bucket fields (`durationBucket`, `costBucket`, etc.), `topToolNames`, `triggeredFromSkill`, `workerSelfAssessment`, `c2Promoted`, `escalated`/`fallbackTriggered` booleans dropped from wire.
- **`reviewedRoutes` expanded from 2 to 7 routes.** Quality review stages now emitted for audit, review, verify, debug, and investigate routes in addition to delegate and execute-plan.
- **Queue format updated (server).** Queue records now store batch-wrapper fields inline (`installId`, `mmagentVersion`, `os`, `nodeMajor`, `events[]`) instead of nested `install` object with `language`/`tzOffsetBucket`.

### Removed
- **Deprecated event types deleted.** `session.started`, `install.changed`, `skill.installed` event types and their emitters/builders removed. Install liveness tracked server-side via batch wrapper; skill usage visible via route distribution on `task.completed`.
- **`FAMILY_MAP` and `deriveModelFamily` deleted.** Replaced by profile-driven `normalizeModel().family` lookup. `BoundedIdentifier` deleted; replaced by `STRICT_ID_REGEX`.
- **`deriveTopToolNames` and `normalizeModelForTelemetry` deleted.** `topToolNames` field removed from V3 wire format.

## [3.9.1] - 2026-04-29

### Fixed
- **Codex skill installation (server).** `mmagent install-skill --target=codex` now writes each MMA skill to Codex's native `~/.codex/skills/<skillName>/SKILL.md` location instead of overwriting a single managed `AGENTS.md` block; installs also clean up the legacy MMA-managed block while preserving user-authored `AGENTS.md` content.

## [3.9.0] - 2026-04-29

### Added
- **per-stage idle telemetry (core).** New `StageIdleTracker` records per-stage `maxIdleMs`, `totalIdleMs`, and `activityEvents` on every reviewed-lifecycle stage; rolled up to a task-level `taskMaxIdleMs`. Surfaced on `RunResult.stageStats` (per-stage), on the local `task_completed` JSONL event, and on the heartbeat as `stage_idle_ms` (distinct from the existing global `idle_ms`).
- **`transitionStage` lifecycle helper (core).** Wraps all 12 stage transitions in `reviewed-lifecycle.ts` so the idle tracker resets on every transition (not just the 6 sites that emit JSONL `stage_change`). Eliminates a class of bug where reworks/loop-back transitions silently inherited prior-stage idle counters.
- **local `task_completed` JSONL emission (core).** Schema-defined but never emitted prior; now fires from the lifecycle's `finally` block with the new `taskMaxIdleMs`, `stallTriggered`, and JSON-stringified `stages` map. Cloud `task.completed` payload unchanged.
- **integration tests for watchdog behavior (tests).** `watchdog-reviewer-stall.test.ts` and `watchdog-total-cap.test.ts` exercise the full stall-abort and total-cap paths against the reviewed-lifecycle harness.

### Fixed
- **stall watchdog now actually catches reviewer hangs (core).** All three reviewer entry points — `runSpecReview`, `runQualityReview` (gating + retry + annotation), `runDiffReview` — now thread `taskDeadlineMs`, `abortSignal`, and `onProgress` through their internal `delegateWithEscalation` calls. Caller-side wiring at all 5 reviewer call sites in `reviewed-lifecycle.ts` passes the orchestrator's stall controller through. Closes the leak that produced the 32-min hang on batch `1574b3a2` despite the documented 30-min cap.
- **`markRunnerEvent` fires unconditionally (core).** Previously gated on telemetry-consumer presence (`needHeartbeat`); when no consumer was wired (CLI / unit-test contexts), the watchdog counter stayed frozen at `taskStartMs` and the stall watchdog tripped at exactly `stallTimeoutMs` regardless of activity. The watchdog is a safety mechanism, not a telemetry feature.
- **`prevEventAtMs` initialized + updated unconditionally (core).** Was gated on `verbose`; when `verbose=false` but a heartbeat consumer was wired (HTTP request paths with `bus`), the JSONL `idle_ms` field reported `Date.now() - 0 ≈ 1.77 trillion`. Now initialized to `Date.now()` at start and advanced on every `turn_start | text_emission | tool_call | turn_complete` event regardless of `verbose`.
- **Zod event schemas aligned with wire format (core).** `HeartbeatEvent` renamed `idleMs → idle_ms`, added `round`/`cap`/`stage_idle_ms` fields. `StallAbortEvent` renamed `idleMs → idle_ms`, `thresholdMs → threshold_ms`. `review_decision` emit at the diff-review path now maps `verdict.kind` (`approve`/`reject`/`transport_failure`) to enum values (`approved`/`changes_required`/`error`), matching the same mapping the adjacent `endReviewStage` call already used.

### Changed
- **task wall-clock cap bumped 30 → 60 min, stall watchdog bumped 10 → 20 min (core).** New named constants `DEFAULT_TASK_TIMEOUT_MS = 3_600_000` and `DEFAULT_STALL_TIMEOUT_MS = 1_200_000` in `config/schema.ts` are the single source of truth; 9 inline `?? 1_800_000` fallback sites and 1 `?? 600_000` fallback updated to reference them. The unrelated 30-min `idleProjectTimeoutMs` (server project eviction) and the 30-min telemetry bucket boundary in `bucketing.ts` are intentionally unchanged.
- **`StageStats` schema extended (core).** `BaseStageStats` adds `maxIdleMs`, `totalIdleMs`, `activityEvents` (each `number | null`; null when stage was never entered). `endBaseStage`, `endReviewStage`, `endVerifyStage` helpers gain an `idle` parameter; `emptyStats()` initializes the new fields to `null`.
- **`HeartbeatTickInfo` adds `stageIdleMs` (core).** `HeartbeatTimer` tracks a per-stage `stageLastEventMs` cursor (reset on stage transitions) distinct from the existing global `lastLlmMs`/`lastToolMs`/`lastTextMs`. Operators watching the JSONL stream can now distinguish "current stage is silent" from "global counter remembers an old gap from a prior stage."

## [3.8.1] - 2026-04-28

### Changed (BREAKING)
- **read-only review is annotation, not gating.** All 5 read-only routes (`audit`, `review`, `verify`, `investigate`, `debug`) replace the gating `quality_only` review with a single annotation pass. The reviewer no longer returns `'approved'` / `'changes_required'`; it returns a JSON array of `{id, reviewerConfidence, reviewerSeverity?}` annotations matched to worker findings by `id`. The lifecycle merges annotations into the envelope's `findings[]` and exits — no rework loop. This restores ~10–15 min audit wall-clock (3.7.0 baseline) versus ~30 min in 3.8.0.
- **`Finding` schema simplified.** Drop `file`, `line`, `sourceQuote`. Rename `suggestedFix` → `suggestion` (more general — works for investigate's follow-up questions too). Add required `evidence: string` (≥20 chars; embed `file:line` as prose plus a one-sentence explanation of what the cited code shows). Add reviewer-emitted `reviewerConfidence: number` (integer 0-100) and optional `reviewerSeverity: 'high'|'medium'|'low'`. Worker emits `WorkerFinding`; reviewer annotation produces `AnnotatedFinding` (which is what ends up in the envelope).
- **Verdict simplification.** For read-only routes `qualityReviewVerdict` replaces `'approved'`/`'changes_required'` with `'annotated'`. `'error'` and `'skipped'` carry forward. `roundsUsed ∈ {0, 1}`. Artifact-route gating (`reviewPolicy: 'full'`) is unchanged.
- **`read_only_review.rework` telemetry event removed entirely** (no rework path exists for read-only routes anymore). `ReadOnlyReviewQualityEvent` gains `severityCorrections` (count) and `meanConfidence` (0-100, nullable) so dashboards keep meaningful signal under the new model.

### Added
- **`mma-investigate` per-route prompt wired (bug fix).** `buildInvestigateQualityPrompt` was defined in 3.8.0 but never passed to `executeReviewedLifecycle` from `investigate.ts` — investigate fell through to the generic gating prompt. Now wired correctly, matching the other 4 read-only executors.

### Fixed
- **`mma-execute-plan` SKILL.md no longer documents an `agentType` field.** The server's Zod schema for `/execute-plan` does not accept `agentType` (and intentionally so — tier should come from the plan, not the dispatcher). The doc-vs-server drift had been silently producing 400s. SKILL.md updated; readers needing direct tier control are pointed at `mma-delegate`.



### Added
- **read-only review lifecycle.** All 5 read-only routes (`audit`, `review`, `verify`, `investigate`, `debug`) now run a single `quality_only` review stage with bounded rework. The lifecycle skips spec_review and runs quality_review only, capped by `maxReworksFor('quality')`. Worker tier is forced `complex`; reviewer tier is forced `standard` — cross-tier review is mandatory for these routes.
- **structured `findings[]` schema (core).** New `findingSchema` in `executors/_shared/findings-schema.ts` defines the canonical worker output: `{id, severity ('high'|'medium'|'low'), file (string|null), line (1-indexed|null), claim, sourceQuote?, suggestedFix?}`. All 5 read-only routes' OUTPUT_CONTRACT_CLAUSES now require this shape.
- **5 per-route quality review prompts (core).** `review/quality-only-prompts.ts` exports `buildAuditQualityPrompt` / `buildReviewQualityPrompt` / `buildVerifyQualityPrompt` / `buildInvestigateQualityPrompt` / `buildDebugQualityPrompt`. Each is route-aware and consumes the worker's `findings[]` for per-finding judgments.
- **envelope verdict fields.** `ExecutorOutput` and `buildOutputEnvelopeSchema` gain `specReviewVerdict`, `qualityReviewVerdict`, `roundsUsed`. Read-only routes emit `specReviewVerdict: 'not_applicable'` plus the actual quality verdict (`approved` / `concerns` / `changes_required` / `error` / `skipped`).
- **HTTP cross-tier guard (server).** `cross-tier-guard.ts` rejects requests with HTTP 400 when both `standard` and `complex` agent slots aren't configured for read-only routes. Wired into all 5 read-only handlers.
- **`MMAGENT_READ_ONLY_REVIEW` kill switch (core).** Env var disables read-only review (per-route via `MMAGENT_READ_ONLY_REVIEW_AUDIT=disabled` etc., or globally via `MMAGENT_READ_ONLY_REVIEW=disabled`). Falls back to today's behavior — emit `qualityReviewVerdict: 'skipped'` and `roundsUsed: 0`. Documented rollback path.
- **read-only review telemetry events.** `read_only_review.quality`, `read_only_review.rework`, `read_only_review.terminal` events emitted from the lifecycle for end-to-end visibility into quality-stage progress and rework rounds.

### Changed (BREAKING)
- **`verify_work` worker tier `standard → complex`.** Per-item verify cost grows ~5–10x; required for cross-tier review guarantee. ROUTE_DEFAULTS for `verify_work` updated; executor's hardcoded slot raised.
- **`investigate` input schema removes `agentType`.** Per spec G2, `agentType` is no longer caller-configurable for `investigate` — hardcoded `complex` inside the executor. HTTP requests with `agentType` now return 400. ROUTE_DEFAULTS for `investigate_codebase` keeps `complex`.
- **`review_code` and `debug_task` review policy `full → quality_only`.** Deliberate downgrade per spec G1 — spec compliance is a subset of quality grounding for findings-shaped output. `audit_document`, `verify_work`, `investigate_codebase` ROUTE_DEFAULTS likewise change to `quality_only`.
- **`reviewPolicy` union widened.** `TaskSpec.reviewPolicy` and `DraftTask.reviewPolicy` accept `'quality_only'` (in addition to `'full' | 'spec_only' | 'diff_only' | 'off'`). Artifact-route Zod enums (`delegate`, `execute-plan`) deliberately NOT widened — `'quality_only'` is rejected at the HTTP boundary for artifact routes; runtime guard in `executeReviewedLifecycle` catches internal misuse.

### Fixed
- **stale tests aligned with new topology.** `resolve-investigate.test.ts` (ROUTE_DEFAULTS expectations), `investigate.test.ts` handler test 7 (now expects 400 for `agentType`), `reviewed-execution/investigate.test.ts` test 25 (summary now wrapped with `[Reviewed]` prefix), OpenAPI goldens regenerated.
- **date-rollover bug in `local-log-sink.test.ts`.** Test was hardcoded to `2026-04-27` filename; now derives the date from `now()`.



### Added
- **observability.** Single `EventBus` with `LocalLogSink` + `TelemetrySink`. Zod-typed event taxonomy in `core/observability/events.ts`.
- **telemetry (v2).** SCHEMA_VERSION 1 → 2 with 11 new fields on `TaskCompletedEvent`: `filesWrittenBucket`, `c2Promoted`, `workerSelfAssessment`, `concernCount`, `escalationCount`, `fallbackCount`, `turnCountBucket`, `stallTriggered`, `clarificationRequested`, `parentModelFamily`, `briefQualityWarningCount`.
- **delegate.** `task_completed` local event mirrors the cloud-bound payload for per-task debugging.

### Fixed
- **delegate (P1).** `terminationReason.cause = 'finished'` is now set on the success early-return path; previously every successful task was reported with `terminalStatus='incomplete'` in cloud telemetry.
- **delegate (P2).** C2 promotion now honors `task.skipCompletionHeuristic`; audit/review/debug tasks (no file writes) can promote `incomplete → ok` when the worker reports `done` with substantive output.
- **observability (P3).** `fallback`/`escalation` events no longer double-emit. The dual `logger.fallback() + emitTaskEvent()` path is replaced by a single `bus.emit()` call.
- **heartbeat (P4).** `setStage('terminal')` now auto-stops the timer; post-stop `emit()` is a no-op.
- **observability (P5).** Heartbeat-side `stage_change` emission removed; explicit lifecycle calls are authoritative.

### Changed (BREAKING)
- **local-log field naming.** All field names normalized to camelCase. `idle_ms`→`idleMs`, `input_tokens`→`inputTokens`, `output_tokens`→`outputTokens`, `duration_ms`→`durationMs`, `exit_code`→`exitCode`, `error_message`→`errorMessage`. The `mmagent logs` CLI is unaffected (streams lines as-is).
- **event taxonomy.** Removed: `task_phase_change` (folded into `stage_change`), `task_heartbeat` (folded into `heartbeat`), `heartbeat_timer` (deleted; lifecycle inferable from first/last `heartbeat`), `llm_turn` (folded into `turn_complete`).
- **DiagnosticLogger.** `disconnect-log.ts` renamed to `http-server-log.ts`; task methods (`taskStarted`, `taskHeartbeat`, `taskPhaseChange`, `escalation*`, `fallback*`, `batchCompleted`, `batchFailed`) deleted. HTTP/server-lifecycle methods retained.

## [3.6.7] - 2026-04-27

### Added
- **`BoundedIdentifier` schema (core).** Permissive shape-only validator for fields whose vocabulary the CLI doesn't control: any string matching `[A-Za-z0-9._:/\-]+` and 1–120 chars. Replaces the strict allowlist enums on `implementerModel`, every `stages.*.model`, `client`, `topToolNames`, and `triggeredFromSkill`. The schema validates **shape, not vocabulary** — Anthropic 4.x, OpenAI o-series, Bedrock vendor prefixes, OpenRouter `meta-llama/...`, Ollama `llama2:7b`, custom finetunes, and arbitrary MCP tool names all pass through verbatim instead of being rejected or collapsed to `'other'`. Length cap prevents PII smuggling; charset rejects spaces/quotes/`@`/control chars.
- **`ModelFamily` enum widened from 5 to 12 values (core).** `claude`, `openai`, `gemini`, `deepseek`, `grok`, `mistral`, `meta`, `qwen`, `zhipu`, `kimi`, `minimax`, `other`. `deriveModelFamily` is now exported and covers the 12 families with prefix matching (incl. `o1`, `o3`, `o4`, bare `openai` for the openai family). Hosting/routing layers (Ollama, OpenRouter) deliberately not added — the underlying model classifies on its own (e.g. `llama2:7b` → `meta`).
- **`'other'` capability fallback (core).** `Capability` enum gains `'other'`; `event-builder` maps unknown capability strings to `'other'` so future model-profiles entries don't force a backend update before they ship.

### Changed
- **`allowlistModel` → `normalizeModelForTelemetry` (core).** Renamed and rewritten: validate shape via `BoundedIdentifier`, return input unchanged if valid, fall back to `'other'` only for null/empty/shape-violating inputs. Defensive normalization, not vocabulary gating. Five call sites updated.
- **`deriveTopToolNames` is now permissive (core).** `ALLOWLISTED_TOOL` set deleted; tool names that pass `BoundedIdentifier` shape pass through unchanged (no longer collapsed to `'other'`). `SNAKE_TO_CAMEL` normalization preserved (`read_file` → `readFile` etc.). Top-N bumped from 5 to 20 to match the new schema cap.
- **`BuildContext` field types widened (core).** `client` and `triggeringSkill` now typed as `string` instead of narrow unions, matching the new permissive wire shape — TypeScript no longer rejects real-world client/skill identifiers at the call-site boundary.
- **`ALL_MODEL_IDS` documented as cost-only (core).** Docstring clarifies the constant is for cost/profile lookup, NOT a telemetry allowlist. Adding/removing entries here does not affect what telemetry accepts.
- **`PRIVACY.md` updated (repo + npm).** New "About model identifiers" section: we don't filter or reject your model name — Anthropic, OpenAI, Google, locally-hosted Ollama, custom fine-tunes, corporate proxy aliases all pass through unchanged. Field classification table updated to mark these fields as "Public (bounded string)" rather than "Public (enum)".

### Removed
- **`KnownModelId`, `ModelIdOrOther` Zod schemas (core).** Replaced by `BoundedIdentifier`. The `import { ALL_MODEL_IDS } from '../routing/model-profiles.js'` line in `types.ts` is gone — telemetry types no longer depend on the model-profiles cost table.
- **`ALLOWLISTED_TOOL` set (core).** The 8-entry hardcoded tool allowlist is gone; permissive shape validation replaces it.

### Fixed
- **`stage-stats.test.ts` was environmentally coupled to runner cwd (core).** The `records verifying stage when autoCommit=true` test used `process.cwd()` (the mmagent repo) and `executeReviewedLifecycle`'s pre-flight `git status --porcelain` check aborted with `errorCode='dirty_worktree'` whenever the repo had any uncommitted change, making the test appear flaky. The test now initializes a fresh git repo in `mkdtempSync()` and passes it as `task.cwd` — verified consistent pass over five consecutive runs and across full-suite runs (1833/1833).
- **DeepSeek-V4-Pro pricing reflects the limited-time 75% off discount (core).** Updated `model-profiles.json` per the official pricing page: input `$0.435`, output `$0.87` (was `$1.74` / `$3.48`), valid until 2026-05-05 15:59 UTC. Annotated for revert in the `bestFor` field. Flash pricing unchanged.

## [3.6.6] - 2026-04-27

### Fixed
- **Vendor-prefixed model IDs are now recognized (core).** Configs that route Anthropic models via AWS Bedrock (`bedrock.claude-haiku-4-5`, `anthropic.claude-haiku-4-5-v1:0`), GCP Vertex (`vertex/claude-sonnet-4-5`, `vertex_ai/...`), Azure (`azure/gpt-5.5`, `azure_openai/...`), or `anthropic.`-namespaced names previously fell through to the empty default profile — no pricing, broken `savedCostUSD` / ROI, and a `modelFamily` of `"bedrock.claude"` (not in the canonical enum) that caused server-side `.strict()` validation to silently 400-drop every `task.completed` event with no daemon-side observability. New `extractCanonicalModelName()` strips known vendor prefixes (idempotently, repeated for compound prefixes like `vertex_ai/anthropic.`) plus the Bedrock `-vN:M` revision suffix; integrated into `findModelProfile()`, `modelFamily()` (which also now maps raw prefixes like `gpt` to canonical families like `openai`), and the telemetry event-builder so on-the-wire `implementerModel` is always the canonical form. Tests pin every vendor variant + bare-name passthrough + idempotence + case-insensitive prefix matching.

## [3.6.5] - 2026-04-27

### Fixed
- **Pre-clarification false positives in intake classifier (core).** The classifier was over-eager: ordinary technical English ("telemetry **system**", "**publish** docs", "**send** a request", "**push** the changelog to npm") tripped the multi-scope or behavior-change heuristics and wedged tasks into `awaiting_clarification` with no real safety win. Two changes: (1) drop the `multiScopeSignals` regex entirely — singular/plural matches on `module|service|component|system|layer` carried no information about destructiveness and other layers (cwd-only sandbox, cost ceilings, dirty-worktree pre-flight on `autoCommit`) cover real risk; (2) tighten `behaviorChange` to require dangerous **verb + object** combinations — `rm -rf`, `drop table/database/schema/index`, `delete (the)? table|database|files|users|...`, `deploy/publish/release to production|prod|staging|main|master`, `force push`, `push to main|master`, `migrate (the)? production|database|schema`. Bare `send`/`push`/`publish`/`migrate` no longer flag. Genuine destructive prompts still flag with the same `behavior-changing task without explicit scope` reason.

## [3.6.4] - 2026-04-27

### Added
- **Per-install Ed25519 identity, trust-on-first-use (core).** First serve generates a keypair stored at `~/.multi-model/identity/{public.pem,private.pem,install-id}`. The `installId` is now derived from the public key (TOFU) rather than a separately-allocated UUID; `recorder` uses `identity.installId` so every event is bound to the local key material.
- **Signed telemetry uploads (server).** The `Flusher` now serializes the upload batch as canonical JSON, signs it with the install's Ed25519 private key, and sets `X-Mmagent-Public-Key`, `X-Mmagent-Signature`, and `X-Mmagent-Install-Id` headers on every POST. Receivers can verify the payload was produced by the install whose `installId` is reported, and reject tampered batches.
- **Top-level `PRIVACY.md` (repo + npm).** Published privacy contract: every collected field, every enum value, every consent surface. A new contract test (`tests/contract/privacy-fields.test.ts`) keeps the doc honest by failing CI if a schema field is added without a matching disclosure entry.
- **Telemetry first-run notice rewording (server).** The first-boot stderr banner now leads with "anonymous-by-design": consent surface, opt-in path, and link to PRIVACY.md — no surprises on the next boot.

### Changed
- **Strict Zod validation on `UploadBatch` and every event shape (core).** `UploadBatch` and each `TelemetryEvent` variant now use `.strict()`, so unknown fields fail closed instead of being silently accepted. Event-builders are the only producers; downstream backends can rely on the schema being exhaustive.

### Fixed
- **`bucketTz` placed UTC−6 in the wrong bucket (core).** The boundary `[−6, 0)` was being treated as `(−6, 0)`, so an offset of exactly −6h fell into `utc_minus_12_to_minus_6` instead of `utc_minus_6_to_0`. Now half-open at the lower edge per the documented enum semantics.

## [3.6.3] - 2026-04-26

### Added
- **Telemetry uploader wired into `mmagent serve` (server).** The `Flusher` class shipped in 3.6.0 but was never instantiated, so opt-in events sat in `~/.multi-model/telemetry-queue.ndjson` indefinitely. 3.6.3 starts a flusher at serve boot that POSTs gzipped `UploadBatch` payloads on a 5-minute cadence (5 s boot delay, exponential backoff with 1 hr cap on transport errors). Drain is wired into both signal-driven shutdown and programmatic `stop()` so in-flight events get a 2 s window to ship before exit.
- **Self-hostable telemetry endpoint (server).** Operators can override the upload destination with `MMAGENT_TELEMETRY_ENDPOINT=<your-url>`; setting it to an empty string disables uploads (events stay queued locally). **Consent stays opt-in:** with `MMAGENT_TELEMETRY` unset and no `telemetry.enabled` in config, the recorder builds nothing, the queue stays empty, and the flusher's tick is a no-op regardless of which endpoint is configured. Out-of-the-box behavior unchanged — nothing leaves your machine until you explicitly opt in.

## [3.6.2] - 2026-04-26

### Fixed
- **Telemetry recorder fired on only 2 of ~5 lifecycle exit paths (core).** `recorder.recordTaskCompleted` was wired only at the natural success-return and the catch-block, so early returns (`reviewPolicy: 'off'`, diff-only, all-tiers-unavailable, both-unavailable) never produced a `task.completed` event. Now hoisted into a `finally` block via a `__recordOnce(result)` helper that captures the final `RunResult` from any exit path, ensuring exactly-one event per task regardless of which branch the lifecycle takes.
- **`errorCode` defaulted to `'other'` for non-error outcomes (core).** When `terminalStatus` was `incomplete` / `timeout` / `cost_exceeded` / `brief_too_vague` / `unavailable`, the event-builder set `errorCode: 'other'` even though those terminal states aren't error categories. Now `errorCode` is `null` unless `terminalStatus === 'error'` or the runner attached an explicit `structuredError.code` — keeps "Top failure modes" panels from being polluted with non-failures.

## [3.6.1] - 2026-04-26

### Fixed
- **Strict config schema rejected the `telemetry` block (core).** 3.6.0 documented `~/.multi-model/config.json` as the canonical place to set `{ "telemetry": { "enabled": true } }` (per `mmagent telemetry enable` and PRIVACY.md), but the root `multiModelConfigSchema` was `.strict()` and didn't list `telemetry` as a known key. Result: `mmagent serve` errored with `Unrecognized key: "telemetry"` on any config that opted in. The schema now declares an optional `telemetry: { enabled: boolean }` block — the actual consent decision is still made in the dedicated consent loader.


## [3.6.0] - 2026-04-26

### Added
- Pseudonymous, low-cardinality usage telemetry instrumentation, **off by default in 3.6.0**. **No network upload in this release** — when enabled via `mmagent telemetry enable` (or `MMAGENT_TELEMETRY=1`, or `~/.multi-model/config.json: { telemetry: { enabled: true } }`), events queue locally to `~/.multi-model/telemetry-queue.ndjson` and never leave the machine. Active upload to a receiver service activates in a follow-up release once the backend is deployed.
- `mmagent telemetry status|enable|disable|reset-id|dump-queue` CLI for controlling the pipeline and inspecting the local queue.
- `docs/PRIVACY.md` — the published privacy contract; truthful + exhaustive disclosure of every collected field with every enum value.

### Changed
- `RunResult` now carries `stageStats` (per-stage cost / duration / agent / model — source data the event-builder buckets).
- `HeartbeatStage` extended with `verifying`, `diff_review`, `committing`, `terminal` to round out the observable lifecycle surface.

## [3.5.3] - 2026-04-26

### Fixed

- **Tasks could exceed `defaults.timeoutMs` indefinitely (core).** `timeoutMs` was applied per-runner-call, so retries (api_error / network_error / timeout) and tier fallbacks each got a fresh 30-min budget — the orchestrator-level wall-clock had no upper bound. Now `defaults.timeoutMs` is a hard task-level cap: per-call timeouts are clamped to remaining budget, and the retry / fallback loops short-circuit when the deadline is past, returning the best salvage so far. *Behavior change*: a task that previously spent N×30 min across retries now finishes within `timeoutMs` total.
- **Silent stalls (model thinking forever, transport hung) burned the full timeout (core).** No watchdog detected runs that had no LLM / tool / text activity for minutes. New `defaults.stallTimeoutMs` (default 10 min) aborts the in-flight `provider.run` via an external `AbortSignal` plumbed through all three runners (claude, openai-compatible, codex) and `withTimeout`. The runner force-salvages and returns; retry / fallback loops also bail. Emits a `stall_abort` diagnostic event with `idle_ms` + `threshold_ms`.
- **`turn_start` events mislabeled `claude-compatible` agents as `claude` (core).** The runner hardcoded `provider: 'claude'`; now it emits `provider: providerConfig.type`. Added `model` field on `turn_start` events across all runners so the configured model name (e.g. `deepseek-v4-pro`) shows on every turn in stderr verbose and JSONL — not just on the one-time `worker_start`.

### New features

- **`defaults.stallTimeoutMs`** — operator-tunable idle threshold for the new stall watchdog. Default 600000 (10 min). Set to a larger value if you have legitimately long-running single tool calls (huge diffs, slow shell scripts).

## [3.5.2] - 2026-04-25

### New features

- **`claude-compatible` agent type (core).** Routes Anthropic-format-compatible third-party endpoints (e.g. DeepSeek's `https://api.deepseek.com/anthropic`) through the existing claude runner. Mirrors `openai-compatible`: required `baseUrl`, optional `apiKey` / `apiKeyEnv`. Enables DeepSeek V4 (and other Anthropic-compatible vendors) as a `complex` slot with thinking ON, since Anthropic's wire format preserves thinking content blocks across multi-turn tool use. Wiring is per-invocation via `Options.env = { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }`, so a sibling `claude` agent on the real Anthropic backend is unaffected.

### Fixed

- **DeepSeek thinking-mode 400 in `openai-compatible` (core).** DeepSeek V4 hybrid models default to thinking mode and emit a non-standard `reasoning_content` field on every assistant turn. DeepSeek's chat-completions endpoint requires that field be echoed back on follow-up requests; the `@openai/agents` SDK strips it because it's not in the OpenAI spec, producing `400: The reasoning_content in the thinking mode must be passed back to the API` on the second turn of every tool-using call. Fix: when the configured baseUrl or model name matches DeepSeek, send `thinking: { type: 'disabled' }` via `ModelSettings.providerData`. Trade-off: no thinking on the openai-compatible path. Users wanting full reasoning should configure DeepSeek as `claude-compatible` instead.

## [3.5.1] - 2026-04-25

### Fixed

- **Same-provider config no longer burns a doomed cross-tier fallback call (core).** Operators may legitimately point `agents.standard` and `agents.complex` at the same backend (one-provider deployment). Previously, when the assigned-tier call transport-failed, `runWithFallback` would substitute to the alt tier — which in that configuration just hits the same backend, burning a second doomed call and surfacing as `bothUnavailable: true` / `terminationReason: 'all_tiers_unavailable'` instead of the actual root-cause status from the original call. Fix: detect identical effective provider config (`providersIdentical`, deep-equal serialized config) inside `runWithFallback` and short-circuit the cross-tier fallback when alt would just hit the same backend. The original failure flows through as the call's terminal result; the assigned tier is still marked sticky-unavailable so subsequent rework calls in the same task short-circuit at the up-front availability check too. No new operator config, no new error code, no behavior change for distinct-tier configurations.
- **Verbose-stream `runner_crash` on fallback / rework paths (core).** `composeVerboseLine` validates field keys against `^[a-z][a-z0-9_]*$`. Several `emitTaskEvent` call sites in `reviewed-lifecycle` (the fallback / fallback_unavailable / escalation / escalation_unavailable wrappers, and the `stage_change` emits on `spec_rework` / `quality_rework`) forwarded the typed `Params` shapes verbatim, which carry camelCase keys (`assignedTier`, `usedTier`, `implTier`, `reviewerTier`, `triggeringStatus`, `violatesSeparation`, `attemptCap`, plus `batchId` / `taskIndex` already covered by `batch` / `task`). Any run with `diagnostics.verbose: true` that reached one of those paths threw `verbose-line: invalid key name (key=...)`, which surfaced as terminal `runner_crash` even though the model itself succeeded. Fix: new `toVerboseFields` helper in `diagnostics/verbose-line.ts` drops `batchId` / `taskIndex` and snake_cases the rest; wired into the verbose-stream branch of `emitTaskEvent` only. The JSONL `DiagnosticLogger` path is untouched, so the `escalation` / `fallback` JSONL contract (camelCase `assignedTier` / `implTier` / ...) stays valid.

## [3.5.0] - 2026-04-25

### Breaking changes
- `task.maxReviewRounds` removed from `TaskSpec`; replaced with derived per-loop caps (`maxReworksFor('spec') = 2`, `maxReworksFor('quality') = 2`). Callers passing the field receive `400 invalid_request`.
- `agentType` removed from `/execute-plan` request body (per-task and top-level). Callers receive `400 invalid_request` with `fieldErrors[<path>]`. `/delegate` is unchanged.
- Status-level escalation in `delegateWithEscalation` removed. Initial transport failures now surface as `incomplete` (after one cross-tier fallback attempt).
- `terminationReason` envelope field union widened with `'all_tiers_unavailable'`.
- `RunStatus` union widened with `'unavailable'` (used by synthetic both-unavailable result).

### New features
- **Tier-escalating rework.** For standard tasks, the rework loop runs the implementation on standard for the first 2 attempts; complex implements the last attempt. Reviewers swap to preserve impl≠reviewer. Complex tasks do not policy-escalate.
- **Runtime tier fallback.** When an assigned provider transport-fails (api_error / network_error / timeout) or is not configured, the lifecycle automatically substitutes the alternative tier for that call. Sticky per loop.
- **Single-slot operators now get reviews** on the same tier (impl=reviewer accepted, flagged with `violatesSeparation: true`). Operators preferring no-review can set `reviewPolicy: 'off'`.
- **Four new diagnostic events:** `escalation`, `escalation_unavailable`, `fallback`, `fallback_unavailable`.
- **New envelope fields:** `agents.implementerHistory`, `agents.specReviewerHistory`, `agents.qualityReviewerHistory`, `agents.fallbackOverrides` (all optional; present only when carrying information beyond the singular fields).
- **Headline composer** surfaces escalation + fallback so operators see tier movement without parsing the envelope.

## [3.4.0] - 2026-04-25

### Added
- **mma-investigate skill + `POST /investigate` endpoint.** Codebase Q&A with structured `file:line` (or `file:line-range`) citations, confidence level (`high`/`medium`/`low`), and unresolved-questions list. Read-only filesystem tools; complex tier by default. Per-task report carries an `investigation` field; worker statuses include `done`, `done_with_concerns`, `needs_context`, `blocked` with `incompleteReason` (`turn_cap`/`cost_cap`/`timeout`/`missing_sections`).
- **`parseStructuredReport.extraSections`** — exposes non-typed section headers (`Record<string, string[]>`) so report consumers can reach beyond the five recognized sections.
- **`parseFilesChanged` / `parseValidationsRun` recognize `(none)` / `none` / `N/A` literals** as empty arrays.
- **`docs/SKILL_WRITING_GUIDELINES.md`** — 9-rule skill-authoring reference distilled from Anthropic's official guide and superpowers' `writing-skills` meta-skill.
- **`packages/server/src/skills/_shared/verify-and-review.md`** — shared `verifyCommand` + `reviewPolicy` snippet, included by mma-delegate / mma-execute-plan.
- **Model profiles refresh** — added `gpt-5.5` / `gpt-5.5-pro` (OpenAI) and `deepseek-v4-flash` / `deepseek-v4-pro` (DeepSeek). `rateLookupDate` bumped to 2026-04-25.

### Changed
- **`executeReviewedLifecycle` preserves the worker structured report when `reviewPolicy === 'off'`.** Previously the lifecycle overwrote the worker's output with a "no file artifacts" wrapper for non-artifact-producing routes. (Also benefits `audit_document`.)
- **Diagnostic logger unification.** Every task-execution event the worker emits to the verbose stderr stream is now also written to the JSONL diagnostic log via a single `emit(TaskEvent)` writer. Removed the per-event typed methods (`taskHeartbeat`, `taskPhaseChange`, `toolCall`, `llmTurn`) on `DiagnosticLogger`. JSONL keys remain camelCase (`batchId`, `taskIndex`); stderr keys remain short-form (`batch`, `task`); event names match across both sinks.
- **All 11 mma-* skills restructured** to follow Anthropic + superpowers best practices: `description` starts with "Use when..." (test-enforced), H1 title, Overview + When-to-Use + Common-pitfalls (❌/✅) sections. Skill line-budget cap raised from ≤80 to ≤200 to accommodate the richer pattern. New contract test (`tests/contract/skills/skill-frontmatter.test.ts`) enforces the description-shape rule.
- **READMEs restructured** for first-time + repeat user clarity: root README has Quick start → Clients → Configuration → REST API → Operator commands → Operations → What's new → Architecture; server README mirrors the structure with the full endpoint table; both updated for the new `/investigate` endpoint.

### Fixed
- **`commit-stage` accepts absolute paths inside cwd.** Previously `validatePaths` rejected ALL absolute paths, blocking legitimate commits when workers produced cwd-anchored paths in their commit blocks (the common case). Now converts inside-cwd absolute paths to their relative form; only paths that truly escape cwd are rejected.

### Removed
- **`DELEGATION-RULE.md`** — stale MCP-era routing doc (3.0.0+ replaced MCP with HTTP). Routing now lives in `multi-model-agent/SKILL.md`'s skill map and per-skill `description` / `when_to_use` frontmatter.
- **23 dead skipped-test placeholders** (auto-commit-lifecycle, status-downgrade, confirm-clarifications, http-events batch+clarification stubs, contract/lifecycle clarification stub) — replaced by current coverage. 7 perf tests moved out of default `npm test` into opt-in `npm run test:perf` / `npm run test:perf:baseline`. Default test run now reports 0 skipped.

## 3.3.0 — 2026-04-25

Reviewed-lifecycle trustworthiness: T1–T7 hardening.

### Breaking

- `BatchCacheEntry.batchId` removed; `/control/retry` and `/control/batch-slice` now accept the same `batchId` returned by `/tools/delegate` (T4).
- `RunResult.commitSha` (single string) removed; replaced with `RunResult.commits: Commit[]` array (T2).
- Worker structured-report `commit: { type, scope, subject, body }` is required when the worker writes files. Workers running pre-3.3.0 prompts that omit it consume up to 2 metadata-repair turns before terminal `failed` `error.code: 'commit_metadata_invalid'` (T2).
- Verbose log format: prose → strict logfmt with canonical key names (`event=`, `ts=`, `batch=`, `task=`, ...). 13-event manifest locked.
- `maxReviewRounds` default changed from 5 to 3. Tasks relying on the longer loop terminate sooner with new `workerStatus: 'review_loop_aborted'` and `terminationReason: 'round_cap' | 'cost_ceiling'` (T1).
- Intake validation: `maxCostUSD`, when explicitly passed, must be a positive finite number (`<=0`, `NaN`, `Infinity` rejected with HTTP 400). Optional with executor default of 10. `verifyCommand: []` and whitespace-only items rejected.
- Pre-existing dirty worktrees on artifact-producing tasks fail the per-task baseline check with terminal `failed` `error.code: 'dirty_worktree'`.
- Lifecycle: every rework round now loops through `committing` and `verifying` before the reviewer.

### Added

- `verifyCommand: string[]` on TaskSpec; service runs commands sequentially under `/bin/bash -lc` between committing and reviewing. Stops on first non-passed step. (T3)
- `verification: { status, steps[], totalDurationMs, skipReason? }` on RunResult — always present (status `'skipped'` when no command). (T3)
- `reviewPolicy: 'full' | 'spec_only' | 'diff_only' | 'off'` on per-task spec for `/tools/delegate` and `/tools/execute-plan` request body. Default `'full'`. (T5)
- `commits: Commit[]` on RunResult — full SHA, subject, body, filesChanged, ISO 8601 committer timestamp.
- `terminationReason`, `reviewRounds: { spec, quality, metadata, cap }`, `concerns: []` (with sources `'spec_review' | 'quality_review' | 'diff_review' | 'verification' | 'diff_truncated'`), structured `error: { code, message, ... }` on terminal envelopes.
- Three new heartbeat tick fields: `idleSinceLlmMs`, `idleSinceToolMs`, `idleSinceTextMs` (T7).
- Observability event manifest locked at 13 events: `request_received`, `batch_created`, `task_started`, `stage_change`, `tool_call`, `text_emission`, `heartbeat`, `commit_recorded`, `verify_step`, `verify_skipped`, `review_decision`, `cost_check`, `task_terminal`. New contract test (`tests/contract/observability/event-manifest.test.ts`) (T6).
- `event=request_received` per dispatch with body inline (≤16 KB UTF-8) or spilled to `~/.multi-model/logs/requests/<batchId>.json` (mode 0600) (T6).
- `runDiffReview` helper for single-pass mechanical-refactor review (T5).
- Reviewer prompts include a structured "Implementation evidence" block (commits, verification output, task-scoped diff up to 64 KB with `diffTruncated` flag) (T1).

### Fixed

- Off-by-one in review-round counter (no more `round=6/5` on a `maxReviewRounds: 5` task). Strict `>=` semantics: cap of 3 → exactly 3 rework attempts.
- Reviewer no longer silently approves on failed verification — auto-converted to `done_with_concerns` with `source: 'verification'`.
- Reviewer evidence is task-scoped (`<taskBaseline.headSha>..HEAD`), not batch-scoped — eliminates sibling-task contamination in multi-task batches.
- Worker-created commits via `git commit` are detected (HEAD-movement check) and read back into `commits[]` instead of being treated as "no files written" (T2).
- Verify-stage timeouts honor remaining task budget (`min(task.timeoutMs/4, 600_000, remaining)`).
- Process-group kill on POSIX so verifyCommand subprocesses (and grandchildren) terminate on timeout.
- Rolling 8 KB tail buffer on verify stdout/stderr — no unbounded memory growth on noisy commands.

### Internal

- New: `packages/core/src/diagnostics/{verbose-line,request-spill}.ts` (logfmt composer + spill helper).
- New: `packages/core/src/run-tasks/{commit-stage,verify-stage,metadata-repair}.ts`.
- New: `packages/core/src/review/{diff-review,evidence}.ts`.
- New: per-route `request-observability.ts` shared helper in server package.
- Refactor: every `[mmagent verbose]` line now goes through `composeVerboseLine`.
- 32 endpoint contract goldens regenerated for new `commits`, `verification`, `reviewPolicy` fields.

## 3.2.0 — 2026-04-25

### Changed (internal refactor; no public API changes)

- **Landing mode:** full-refactor (all eight chapters landed). Tier A/B/C contract baseline + Tier D install/openapi goldens, packages/mcp/ deletion, types + ExecutionContext cleanup, runner adapter interface + shared result-builders + per-runner adoption, intake-compiler review, run-tasks/ decomposition + shim removal, server install/openapi/http-pipeline decomposition, ARCHITECTURE.md + CLAUDE.md + CHANGELOG.
- **Contract test baseline (Ch 1, Tasks 1-12).** New `tests/contract/` suite pins the HTTP response envelope, route manifest, polling lifecycle state machine, observability event + field set, per-endpoint × per-lifecycle-stage envelopes (6×6 = 36 goldens), skill-surface frontmatter + endpoint resolution, per-provider runner RunResult shape via SDK mocks, and orchestrator invariants (worker-status, fallback-report, reviewed-lifecycle, plan-extraction). 85 contract assertions + 40 endpoint goldens. Performance baseline captured at `tests/perf/baseline.json` with a budget-enforcement test.
- **`packages/mcp/` deleted (Ch 2).** Only a dist-only shell remained; no live source was in the repo.
- **`packages/core/src/types.ts` 654 → 147 LOC (Ch 3).** Runner-local types moved to `runners/types.ts`; intake/readiness-local to `intake/types.ts`; routing-local to `routing/types.ts` (new); executor-local (BatchTimings / BatchProgress / BatchAggregateCost) to `executors/types.ts`. Cross-cutting (TaskSpec, Provider, ProviderConfig, RunResult, MultiModelConfig, ToolMode, etc.) stay in `types.ts`. Inventory at `docs/refactor/types-inventory.md`.
- **`ExecutionContext` slimmed (Ch 3, Task 22).** Three dead fields removed: `providerFactory`, `onProgress`, `awaitClarification`. Single factory `buildExecutionContext(input)` at `packages/core/src/executors/execution-context.ts` enforces required-field invariants. The server's `buildExecutionContext` now delegates to the core factory. Dead auxiliary types (`ClarificationProposal`, `ClarificationResponse`, the executors/types.ts `ProgressEvent` shadow) also removed. Audit at `docs/refactor/execution-context-inventory.md`.
- **`RunnerAdapter` interface + shared result-builders + per-runner adoption (Ch 4).** New `packages/core/src/runners/base/types.ts` carries the `RunnerAdapter<ProviderTurn, ProviderUsage>` interface derived from the per-provider viability analysis at `docs/refactor/runner-adapter-matrix.md`. New `packages/core/src/runners/base/result-builders.ts` extracts `buildOkResult / buildIncompleteResult / buildForceSalvageResult / buildMaxTurnsExitResult`. All three runners (claude, openai, codex) now delegate their per-provider buildXResult wrappers to the shared helpers; provider-local cost computation lives in a small `<provider>Usage(args)` helper. Net LOC delta in runners: -160. Task 27's deeper `runWithAdapter` turn-loop unification is intentionally not landed — the matrix concluded the adapter is "viable if kept shallow"; pushing it deeper would force three different SDK iteration models behind a flag-soup interface, which the SDK-mocked runner contract tests would have to ratify per turn-loop branch. The result-builder adoption captures the cheap, safe LOC win.
- **Server package decomposed (Ch 7).** `cli/install-skill.ts` 562 → 349 LOC, with discovery (`install/discover.ts`), per-client dispatch (`install/manifest-resolve.ts`), and pure orchestration (`install/orchestrate.ts`) extracted. `openapi.ts` 344 → 248 LOC via a TOOL_ENDPOINTS table replacing seven near-identical registerPath blocks. `http/server.ts` 316 → 216 LOC with the request pipeline (body cap → route → loopback → auth → JSON → cwd → dispatch) moved to `http/request-pipeline.ts`. Per-client install writers (claude-code, gemini-cli, codex-cli, cursor) left in place — they have genuinely different on-disk layouts and a forced shared base would degrade rather than improve the code.
- **Tier D contract goldens (Ch 1 Task 13).** `tests/contract/openapi/schema.test.ts` pins the generated OpenAPI document byte-for-byte against `tests/contract/goldens/openapi.json`. `tests/contract/install/install-skill.test.ts` drives `doInstall()` for claude-code, gemini, and codex against a temp homeDir and asserts each writes a non-empty file under its expected subdirectory.
- **`run-tasks.ts` decomposed (Ch 6).** The 904-LOC orchestrator was split into `packages/core/src/run-tasks/{index,execute-task,reviewed-lifecycle,worker-status,fallback-report,plan-extraction}.ts`. Internal imports now reference `./run-tasks/index.js`; the public package subpath `@zhixuan92/multi-model-agent-core/run-tasks` is preserved via `packages/core/package.json` exports map (now points at `./dist/run-tasks/index.js`). The old `packages/core/src/run-tasks.ts` shim is deleted. Vitest alias map updated to resolve the subpath to the new index.
- **Docs refreshed (Ch 8).** New `docs/ARCHITECTURE.md` with layer map + request lifecycle + maintainer migration appendix. Root `README.md` points at it. `.claude/CLAUDE.md` (local) updated.

### Bug-fix ratifications

- **`providerFactory` on `ExecutionContext` was dead (PRQ-001).** Harness-installed `__setTestProviderOverride` is not consumed by the run-tasks runner layer. Per-stage endpoint goldens therefore all pin the same connection-error envelope — divergence will appear when Chapter 4's full adapter migration wires a provider via `ExecutionContext`. Goldens are shape-only for that axis; recapture is expected at that point.
- **Clarification intake routing is driven by prompt heuristics, not provider output (PRQ-002 / PRQ-004).** Two tests (`tests/contract/http/confirm-clarifications.test.ts`, one case in `tests/contract/lifecycle.test.ts`) are `it.skip` until the intake compiler pipeline exposes a test seam for forcing clarification. Tracked in `docs/superpowers/refactor/post-refactor-queue.md`.
- **Three narrative-style commit messages in history (PRQ-003).** Commits `992d3b2`, `884dad6`, `baa7d52` on this branch have stream-of-thought subject lines from an earlier subagent session. Left in place to avoid rewriting published history; future subagent dispatches are bound by commit-hygiene rules to avoid recurrence.

### Verification at full-plan close-out

- `npm run build`: green (workspaces: core + server).
- `npm test`: 1144 passed, 15 skipped, 0 failed.
- `npx vitest run tests/contract tests/perf`: 89 passed, 9 skipped, 0 failed.
- `wc -l packages/core/src/types.ts`: 147 (≤150 cap).
- Node subpath resolution `@zhixuan92/multi-model-agent-core/run-tasks` exports `runTasks` + `extractPlanSection`.
- Aggregate `packages/core/src` LOC: 11757 → 11551 (-1.75%). The plan's 25% reduction target was tied to the deep `runWithAdapter` turn-loop unification (Task 27), which is intentionally not landed — see Ch 4 note above. The ratchet points (RunnerAdapter interface, shared result-builders, runner-adapter-matrix) are in place so that work can land in 3.3.x with the SDK-mocked runner contract tests as the safety net.

No public API or HTTP surface changes. Clients and skills installed against 3.1.x continue to work unchanged.

## 3.1.7 — 2026-04-24

### Changed

- **core (`@zhixuan92/multi-model-agent-core`).** `MAX_DEGENERATE_RETRIES` raised from 3 to 6. Workers doing heavy file-reading + analysis (plan implementation, wide refactors) legitimately spend several "thinking" turns before committing to their first `writeFile`/`editFile`/`runShell`. The prior cap killed them mid-analysis with `degenerate_exhausted`. Cost and timeout caps remain unchanged — they are the real bounds on runaway workers. Tests adjusted to pump 7 fragments through the mock to still exhaust the cap.
- **core (`@zhixuan92/multi-model-agent-core`).** `executeExecutePlan` no longer inlines the full plan file into every worker prompt. Previously the entire plan (often 100+ KB) was pasted into the worker's system prompt, blowing initial input to ~40 K tokens and starving the model of headroom. Now the executor calls `extractPlanSection` per task and injects only the matching section (~2–5 KB). The plan file paths are passed as `filePaths` scope so the worker can `readFile` adjacent sections on demand. When the task heading can't be matched to a plan section, the prompt falls back to naming the paths and instructing the worker to read them. Standard-tier workers (MiniMax etc.) can now finish plan tasks that previously drowned in context.

## 3.1.6 — 2026-04-24

### Fixed

- **core (`@zhixuan92/multi-model-agent-core`).** `executeExecutePlan` hardcoded `agentType: 'standard'`, ignoring any tier the caller requested. `mma-execute-plan` now accepts an optional `agentType: 'standard' | 'complex'` in the input schema, and the executor plumbs it through to every dispatched task. Default remains `'standard'` when omitted. Lets users route plan-execution work to the complex tier (e.g. when a standard-tier model burns its turn budget on reads without producing artifacts).

## 3.1.5 — 2026-04-24

### Added

- **skills.** `multi-model-agent` router now includes a preflight block that auto-starts `mmagent serve` in the background if `/health` is unreachable. The main agent runs it once before dispatching mma-* work, so users who haven't started the daemon themselves no longer need to — the skill does it for them. Idempotent (no-op when already running).

## 3.1.4 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** Core-only fixes from 3.1.2 and 3.1.3 were never actually shipped to npm users — server 3.1.1/3.1.2/3.1.3 depended on `@zhixuan92/multi-model-agent-core: ^3.1.0`, which resolved to the un-updated 3.1.0 tarball. This release re-publishes core at 3.1.4 (with the `needHeartbeat` wiring, per-tick / turn_start / text_emission verbose enrichments, and richer heartbeat payload) and bumps the server dep range to `^3.1.4`. Users upgrading to 3.1.4 will finally see the fixes that 3.1.2 and 3.1.3 intended to deliver.
- **core (`@zhixuan92/multi-model-agent-core`).** `loadAuthToken` now expands a leading `~/` to `os.homedir()` so configs with `tokenFile: "~/.multi-model/auth-token"` work out of the box. Previously this caused the `mmagent serve` startup line (`[mmagent] started | version=… | token=<fp> | boot=<uuid>`) to be silently skipped because the fingerprint call couldn't open the file, even though the main server process had loaded it via a separate tilde-aware path. `mmagent info` and any other direct consumer benefits as well.

## 3.1.3 — 2026-04-24

### Added

- **server (`@zhixuan92/multi-model-agent`).** Verbose mode now emits a line on every HeartbeatTimer tick (not just stage transitions) so operators can confirm the timer is firing during long-running stages. Also logs a one-line "heartbeat started" / "heartbeat DISABLED" marker at lifecycle start to surface timer-wiring issues end-to-end.
- **server (`@zhixuan92/multi-model-agent`).** Verbose stream now covers the full per-turn lifecycle: `turn_start turn=N provider=X` when an LLM turn begins, `text +Nc (total Mc) preview="..."` as output streams (first 60 chars), `tool=name(args) +Nms` per tool call with delta-time, and `turn in=X out=Y $Z +Nms (model)` on completion. Heartbeat lines carry `cost=$X round=N/M text=Nc idle=Nms` so operators can spot reasoning-phase worker activity (high idle + growing cost = model is thinking, not stalled).

## 3.1.2 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** `mmagent serve --verbose` was silent after the initial `start worker=...` line for the entire duration of every batch. Root cause: HTTP handlers never pass `onProgress` to `runTasks`, and `run-tasks.ts` gated both HeartbeatTimer creation and `wrappedOnProgress` on `onProgress !== undefined`. The provider runners emit `tool_call` and `turn_complete` events correctly, but with no wrapper to receive them they were dropped. Now gates on "any verbose/logger/recordHeartbeat consumer is present" — so `--verbose` actually streams tool calls and LLM turns as the worker runs.
- **server (`@zhixuan92/multi-model-agent`).** `GET /batch/:id` returned `1/1 queued` plain-text body for every poll during a pending batch, no matter how long the batch ran. `BatchEntry.tasksStarted` was declared in the schema but never written. `asyncDispatch` now sets `tasksTotal=1, tasksStarted=1` when the executor begins, and `tasksCompleted=1` before marking the batch complete. `composeRunningHeadline` now transitions to `1/1 running, Xs elapsed` as intended. Added `tests/server/async-dispatch-progress-wiring.test.ts` as a regression guard.

## 3.1.1 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** `startServe()` was stripping `agents` from the config before handing it to `startServer()`, so every tool endpoint (`POST /delegate`, `/audit`, `/review`, etc.) returned `503 no_agent_config` even when the config file had agents properly defined. Regression introduced during 3.1.0's Phase 1 refactor. Now passes the full MultiModelConfig through so `registerToolHandlers` sees agents and wires real handlers. Added `tests/cli/serve-agents-passthrough.test.ts` as a regression guard. 3.1.0 is npm-deprecated; upgrade to 3.1.1.

## 3.1.0 — 2026-04-24

### BREAKING

- **`GET /batch/:id` response shape split by HTTP status.** Pending → `202 text/plain` plain-text progress line. Terminal → `200 application/json` full envelope. No `state` field — consumers branch on HTTP status. Migration: one conditional per call site.
- **Response envelope uniformity.** Every terminal JSON envelope now has all seven fields (`headline`, `results`, `batchTimings`, `costSummary`, `structuredReport`, `error`, `proposedInterpretation`). Non-applicable fields are `{ kind: "not_applicable", reason: "..." }`. Consumers of `response.structuredReport.summary` etc. must type-narrow.
- **`mmagent print-token` output.** Emits only the token on stdout; warnings go to stderr.
- **Inline-apiKey warning.** No longer fires on every `loadConfigFromFile` — now fires once on `mmagent serve` startup with an actionable fix recipe.
- **Log file rename.** `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` → `mmagent-YYYY-MM-DD.jsonl`. Old files untouched.
- **`install-skill` default.** No positional skill name now installs every shipped skill (was: error). Specify a skill name to scope to one.

### Added

- `mmagent info [--json]` subcommand: cliVersion, bind/port, token fingerprint, and daemon identity (version/pid/startedAt/uptimeMs via `/health`). Works offline (returns `NotApplicable` sentinels when daemon unreachable).
- `mmagent update-skills [--dry-run] [--json] [--if-exists] [--silent] [--best-effort]` subcommand: re-copies every manifest-tracked skill from the shipped bundle, updates `skillVersion`, removes skills no longer in bundle.
- `mmagent logs [--follow] [--batch=<id>]` subcommand: tails today's `mmagent-*.jsonl` with POSIX-sh tail-F semantics.
- `server.autoUpdateSkills` config field (default `true`). `mmagent serve` auto-updates stale skills before bind (bounded 5s; never blocks).
- `mmagent install-skill` with no positional skill name now installs every shipped skill (previous behavior required a skill name or `--all-skills` flag — 3.1.0 flips the default). Pass a skill name to scope to one. `--uninstall` with no skill name removes all installed skills.
- npm `postinstall` hook via `packages/server/scripts/postinstall.js` — zero-touch skill refresh on `npm update`. Always exits 0.
- Plain-text running headline on `GET /batch/:id` during pending. Recomposed every HeartbeatTimer tick; includes stall detection after 2× heartbeat interval.
- Startup log line `[mmagent] started | version=... | bind=... | pid=... | token=<fp> | boot=<uuid>` on stdout before listening.
- `/health` response extended with `version`, `pid`, `startedAt`, `uptimeMs`.
- Diagnostic events `task_started`, `task_heartbeat`, `task_phase_change` on `DiagnosticLogger`. `asyncDispatch` emits `task_started`; `buildExecutionContext`'s heartbeat callback emits `task_heartbeat`.
- Verbose mode: `diagnostics.verbose: boolean` config (default false) + `mmagent serve --verbose` flag. Streams per-tool-call, per-LLM-turn, per-stage-transition, and per-batch-lifecycle events to stderr so operators can profile server behavior and fine-tune efficiency. Orthogonal to log-file persistence — streams without writing any file by default.
- File-log toggle: `diagnostics.log: boolean` config (default false) + new `mmagent serve --log` flag. Decoupled from verbose — stream inline without persisting, persist without stderr noise, both, or neither.
- Verbose tool_call events include `durationMs` (time since prior event); llm_turn includes per-turn duration. New `batch_completed` and `batch_failed` events fire from asyncDispatch with total batch duration and task count / error details. Stage transitions (implementing → spec_review → spec_rework → quality_review → quality_rework) emit `task_phase_change`.
- Skill frontmatter rewrite across every mma-* skill: each describes direct user intent (audit, review, verify, debug, execute-plan, delegate) as the primary trigger and names the superpowers methodology skill it pairs with as a secondary hint. Works for users who do NOT use superpowers too.
- Skill frontmatter `version:` field (sentinel `"0.0.0-unreleased"` in source, stamped to package.json version at build time via `packages/server/scripts/inject-skill-version.mjs`).

### Changed

- Manifest schema v1 → v2: per-entry `version` renamed to `skillVersion`. Auto-migrated on first load with a stderr notice; corrupt files are backed up and rebuilt empty.
- `FutureManifestError` thrown when a newer mmagent's manifest is encountered; tools refuse to mutate rather than corrupt.
- Skill curl examples use `curl -f --show-error -s` with explicit HTTP-status branching instead of `curl -sf`.
- Polling skill snippets: 30s backoff cap (up from 5s), 1800s client-side timeout, per-process `mktemp` body file with `trap` cleanup.
- Auth token file strictly validated (LF-only, `[A-Za-z0-9_\-+=/.]+` regex). `MMAGENT_AUTH_TOKEN` env override bypasses file validation.
- `mmagent help` lists five user-facing subcommands (`serve`, `print-token`, `info`, `status`, `install-skill`, `update-skills`, `logs`).

### Removed

- `state` field from `GET /batch/:id` response body (consumers branch on HTTP status instead).

## 3.0.2 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** Fixed the CLI entry's `isMain()` guard to follow symlinks. 3.0.1's bin worked when executed directly but silently exited 0 when invoked via the npm `.bin/mmagent` symlink, because `path.resolve(argv[1])` returned the symlink path, not the real file, and the identity check against `import.meta.url` failed. Now uses `fs.realpathSync(path.resolve(argv[1]))`. 3.0.1 is npm-deprecated; upgrade to 3.0.2.

## 3.0.1 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** Added missing `#!/usr/bin/env node` shebang to the CLI entry. 3.0.0's published `dist/cli/index.js` was missing the shebang, which caused `mmagent` (invoked via the bin symlink) to be parsed by `/bin/sh` instead of Node and fail with `line 1: /Applications: is a directory`. 3.0.0 is npm-deprecated; upgrade to 3.0.1.

### Changed

- **server (`@zhixuan92/multi-model-agent`).** Rewrote `packages/server/README.md` for the 3.0.0 install + serve + install-skill flow. Previous 3.0.0 tarball shipped the stale 2.x `-mcp` README.
- **core (`@zhixuan92/multi-model-agent-core`).** Rewrote `packages/core/README.md` to reference the renamed `@zhixuan92/multi-model-agent` package. Added `./executors` and `./tool-schemas` subpath entries introduced in 3.0.0.

## 3.0.0 — 2026-04-24

### BREAKING: MCP Removed

`multi-model-agent` is no longer an MCP server. All MCP transports, tool registrations, and the `@modelcontextprotocol/sdk` dependency have been removed. The package is now a standalone HTTP service with client-installable skills.

**Migration from 2.x MCP users:**
1. Remove old MCP registration: `claude mcp remove multi-model-agent`
2. Install new package: `npm i -g @zhixuan92/multi-model-agent`
3. Start the daemon: `mmagent serve` (keep running; see launchd/systemd scripts)
4. Install skills: `mmagent install-skill` (auto-detects Claude Code, Gemini CLI, Codex CLI, Cursor)

The deprecation stub `@zhixuan92/multi-model-agent-mcp@2.8.1` ships separately to surface this message to users who blindly upgrade.

### Package rename
- `@zhixuan92/multi-model-agent-mcp` → `@zhixuan92/multi-model-agent`
- `packages/mcp/` → `packages/server/` (internal only)

### Added
- REST API: 7 tool endpoints (delegate/audit/review/verify/debug/execute-plan/retry), 4 control endpoints (context-blocks, clarifications/confirm, batch), 3 introspection endpoints (health/status/tools)
- Async-with-polling dispatch: `202 { batchId, statusUrl }` + `GET /batch/:id`
- `GET /batch/:id?taskIndex=N` replaces the old MCP `get_batch_slice` tool
- Batch state machine: pending / awaiting_clarification / complete / failed / expired
- Context-block refcount pinning prevents use-after-free during active batches
- 10 installable skills via `mmagent install-skill` supporting Claude Code, Gemini CLI, Codex CLI, Cursor
- `mmagent status` / `mmagent print-token` operator commands

### Removed
- All MCP transports (stdio and HTTP)
- `@modelcontextprotocol/sdk` dependency
- `DELEGATION-RULE.md` (only meaningful with MCP)

## [2.8.0] - 2026-04-23

### Added

- **HTTP transport (mcp).** New opt-in `mmagent serve --http` mode that runs the MCP server as a long-running HTTP/SSE daemon, independent of any Claude Code session's lifetime. The daemon survives Claude Code lifecycle events (compaction, `/clear`, session exit, client crash) that previously tore down the stdio child process and produced "MCP server is down" errors on the next tool call. Stdio remains the default transport; HTTP is opt-in via `--http` flag or `transport.mode: "http"` in config. See the new "Running as an HTTP daemon" section of `packages/mcp/README.md`.
- **Concurrent multi-project sessions (mcp).** A single HTTP daemon serves multiple Claude Code sessions concurrently, each bound to its own project directory via a `?cwd=/abs/path` URL query param on the MCP endpoint. Per-project `ProjectContext` isolates context blocks, batch cache, and clarifications so sessions cannot see each other's state.
- **`transport` config block (core).** New top-level field on `~/.multi-model/config.json`: `{ "transport": { "mode": "stdio" | "http", "http": { bind, port, auth: { enabled, tokenPath }, projectIdleEvictionMs, projectCap, shutdownDrainMs, sessionIdleTimeoutMs } } }`. All fields optional with sensible defaults (stdio mode, port 7312, loopback bind, auth off, 60-min project eviction, 30-min session idle timeout, 30-s shutdown drain). Omitting the block preserves the pre-2.8.0 stdio behavior exactly.
- **Token-based auth (mcp).** Enable via `transport.http.auth.enabled: true`. The daemon generates a 32-byte random token at `~/.multi-model/runtime/token` (mode 600) on first boot and reads it on subsequent boots. Clients present it via `Authorization: Bearer <token>`. Tokens in the query string are explicitly rejected with 401 (prevents leaks via access logs and process listings). A startup safety check refuses to bind to non-loopback addresses unless auth is enabled.
- **Graceful SIGTERM drain (mcp).** In HTTP mode, SIGTERM triggers a global drain: stop accepting new connections, notify active sessions via SSE, wait up to `shutdownDrainMs` for in-flight handlers, then force-close. Shutdown is logged as `SIGTERM` on clean drain or `SIGTERM_drain_timeout` on escalation. SIGHUP is a no-op in HTTP mode (stdio behavior unchanged).
- **Session idle timeout (mcp).** Defense-in-depth against clients that don't call `terminateSession()` on disconnect. A periodic timer (1-min tick) detaches sessions with no request activity for `sessionIdleTimeoutMs` (default 30 min). Emits `session_close reason='session_expired'`. Project stores survive the session eviction so reconnecting clients keep their state.
- **`/status` endpoint (mcp).** Loopback-only `GET /status` returns daemon version, pid, uptime, bind, auth status, per-project stats (sessions, batch cache size, context blocks size, clarifications size), active requests with progress headlines, and a rolling 10-entry recent-requests buffer. Auth-gated when `auth.enabled=true`.
- **`mmagent status` CLI (mcp).** New subcommand that fetches `/status` and formats a human-readable summary. `--json` flag for scripting.
- **`mmagent` bin alias (mcp).** Short alias for `multi-model-agent`. Both binaries point at the same CLI; existing `multi-model-agent` invocations continue to work.
- **New diagnostic log event types (core).** HTTP mode adds `session_open`, `session_close`, `connection_rejected`, `request_rejected`, `project_created`, `project_evicted` to the log stream. `startup` now includes a `transport: 'stdio' | 'http'` field. `request_start` / `request_complete` gain optional `sessionId` and `cwd` fields (both omitted under stdio for backward compatibility). Shutdown cause set extended with `'SIGTERM_drain_timeout'`.
- **`ProjectContext` type (core).** New exported type bundling per-project stores (`InMemoryContextBlockStore`, `BatchCache`, `ClarificationStore`) plus lifecycle metadata (`cwd`, `createdAt`, `lastSeenAt`, `activeSessions`, `activeRequests`, `pendingReservations`). Synthesized once from `process.cwd()` in stdio mode; created per unique `cwd` in HTTP mode. `createProjectContext(cwd)` factory.
- **`BatchCache` class (core).** Extracted from `cli.ts`'s previously-inline Map closures into a named class with explicit status enum (`'pending' | 'complete' | 'aborted'`) and `complete()` / `abort()` state-transition methods. Preserves the 30-min TTL + 100-entry LRU semantics.
- **launchd + systemd service templates (mcp).** New `packages/mcp/scripts/launchd/` and `packages/mcp/scripts/systemd/` with install instructions for running the HTTP daemon as a user service.

### Changed

- **`buildMcpServer` signature (mcp, breaking).** `options` parameter is now **required** and must contain `projectContext: ProjectContext`. Also accepts optional `sessionId?: string`. The three in-memory stores are read from `projectContext` rather than constructed locally — so `buildMcpServer` no longer creates state, it accepts it. Stdio callers synthesize a single `ProjectContext` from `process.cwd()`; HTTP callers construct one per unique `cwd`. Per the development-mode rule, every in-repo call site updates in the same commit (production + tests).
- **`injectDefaults` cwd source (mcp).** Now reads `cwd` from `projectContext.cwd` instead of `process.cwd()`. In stdio mode these are equal; in HTTP mode each session gets the correct per-project cwd.
- **Delegation rule (rules).** Clarified auto-pipeline behavior when MCP is unreachable: stop and report rather than falling back to inline labor. Added "When MCP is down" section to `.claude/rules/DELEGATION-RULE.md`.

### Why

- End users kept reporting "MCP server is down" mid-workflow. Investigation of diagnostic logs across multiple incidents showed the same root cause in every case: Claude Code closed the stdin pipe to the MCP child process (compaction, `/clear`, session exit) and the child dutifully exited with `cause: stdin_end`. The MCP was not crashing — it was being terminated by its parent, and under the stdio transport the MCP server is structurally a child of the client with no way to survive the pipe close. The only path to "MCP survives client churn" is a different transport where the server is not a child of the client. HTTP transport delivers that. Stdio remains the default and unchanged for users who don't opt in; HTTP is additive.



### Changed

- **Diagnostic logging switch moved to the agent config (core, breaking).** Enable/disable and directory override now live in `~/.multi-model/config.json` under a new `diagnostics` block: `{ "diagnostics": { "log": true, "logDir": "/optional/path" } }`. Default remains off. 2.7.4's `MCP_DIAGNOSTIC_LOG` and `MCP_DIAGNOSTIC_LOG_DIR` environment variables are removed entirely — there is no precedence or override layer to reason about. Users who enabled logging in 2.7.4 must move the switch from their MCP client's `env` block into their agent config.
- **`createDiagnosticLogger` signature (breaking).** Now requires an explicit `{ enabled: boolean, logDir?: string }` options object. The logger no longer reads any environment variables. Callers (only `packages/mcp/src/cli.ts` in-repo) pass `config.diagnostics?.log ?? false` and `config.diagnostics?.logDir`.

### Why

- 2.7.4 required users to edit their MCP client's `env` block — a separate surface from the agent config they already maintain at `~/.multi-model/config.json`. Consolidating both knobs into the agent config makes enabling the crash log a one-line edit in the file users already know about, and eliminates an entire class of precedence/override bugs.

## [2.7.4] - 2026-04-21

### Changed

- **Diagnostic logger is opt-in (core, breaking).** The logger created by `createDiagnosticLogger()` is now a complete no-op unless `MCP_DIAGNOSTIC_LOG` is set to a truthy value (`1`, `true`, `yes`, or `on`, case-insensitive). When disabled, the logger performs no directory creation, no file opens, no stat calls — every public method early-returns. When enabled, logs still land at `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` (overridable via `MCP_DIAGNOSTIC_LOG_DIR`). Replaces 2.7.3's on-by-default behavior.
- **Event schema reshaped to 5 types (core, breaking).** The logger now writes exactly `startup`, `request_start`, `request_complete`, `shutdown`, and `error`. Previously-emitted `notification_batch` events (one per 5-second progress burst) are removed entirely — they dominated log volume without aiding crash diagnosis. The old single `request` event is split into `request_start` (emitted before the handler runs) and `request_complete` (emitted after), so the log retains the in-flight tool if the process dies mid-request.
- **Startup banner suppressed when disabled (mcp).** The `[multi-model-agent] diagnostic log: <path>` stderr line now prints only when logging is enabled.

### Added

- **Expanded signal coverage (mcp).** `installStdioLifecycleHandlers` now registers handlers for `SIGTERM`, `SIGINT`, `SIGPIPE`, `SIGHUP`, `SIGABRT`, and `beforeExit`. Each writes a `shutdown` line with the matching `cause` before exit (0 for graceful signals and `stdin_end`; 1 for error-class signals, `uncaughtException`, and `unhandledRejection`). Previously these signals terminated the process with zero log output, indistinguishable from a segfault.
- **`unhandledRejection` is fatal (mcp, breaking).** A rejected promise without a handler now logs an `error` event, emits a `shutdown` with cause `unhandledRejection`, and exits 1. Previously the server logged the rejection and kept running, which could leave the process in a wedged half-alive state.
- **`lastRequestInFlight` on shutdown (core).** If a request is in flight when any shutdown path fires, the `shutdown` line includes `{ requestId, tool, startedAt }` for the most-recent in-flight request, letting us attribute a crash to the tool that was running.
- **Duplicate `requestId` detection (core).** A second `requestStart` for an already-in-flight requestId now writes an `error` event with `kind: "duplicate_request_id"` before replacing the entry, preventing silent diagnostic corruption from buggy callers.

### Removed

- **`notification_batch` event type (core, breaking).** Progress notifications are still delivered to MCP clients via `notifications/progress`; only the logger-side batching output is gone.
- **`progressToken` field on request events (core, breaking).** MCP progress tokens are a consumer-side concern, not a diagnostic one.
- **`NonTerminalErrorCause` from `@zhixuan92/multi-model-agent-core` public exports.** The type only described the old `notification_batch`/`unhandledRejection` error envelope.

### Why

- The 2.7.3 logger shipped on-by-default and was dominated by repeated `notification_batch` lines — in a real disconnect report, ~90% of lines carried no diagnostic signal. Worse, `SIGTERM`/`SIGPIPE` kills still produced zero log output, so a genuine crash and a healthy idle process looked identical at the tail of the file. 2.7.4 treats the log as a crash-diagnosis tool only: off by default so there's no surprise disk write, focused on the events that distinguish "process exited cleanly via stdin_end" from "process was signal-killed" from "process died mid-request." Users who hit a disconnect can enable `MCP_DIAGNOSTIC_LOG=1`, reproduce, and share the resulting file.

## [2.7.3] - 2026-04-20

### Added

- **Stdio lifecycle handlers (mcp).** `installStdioLifecycleHandlers(logger)` registers EPIPE-safe handlers on `process.stdout`, `process.stdin`, `uncaughtException`, and `unhandledRejection`. Without these the server crashed silently when the client closed its read end of the pipe (the "MCP dies every ~2 calls" failure). Single-install contract; a second call is a no-op with a stderr warning.
- **Diagnostic logger (core).** New `@zhixuan92/multi-model-agent-core/diagnostics/disconnect-log` module exports `createDiagnosticLogger()` / `DiagnosticLogger`. The logger writes JSON-Lines events to `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` — one file per UTC day, lazy-materialised on first write, best-effort fs (a broken disk never breaks a working server). Four event shapes: `request` (per tool call with tool, requestId, progressToken, durationMs, responseBytes, status), `notification_batch` (one summary per 5-second burst with attempted/succeeded counters and `since` timestamp), `error` (non-terminal background errors — currently `unhandledRejection`), and `shutdown` (terminal, written synchronously before exit, carries cause, lastRequest with msSinceCompletion, and notificationsSinceLastRequest counters).
- **Per-tool request events (mcp).** Every specialised tool (`audit_document`, `debug_task`, `execute_plan`, `review_code`, `verify_work`, `confirm_clarifications`) now emits a `request` event on each invocation via a new `withDiagnostics(tool, logger, handler)` wrapper in `tools/shared.ts`. Measures wall-clock duration and approximate response-body bytes; on a thrown handler, logs `status: 'error'` with `responseBytes: 0` before rethrowing.
- **Startup banner (mcp).** During normal `serve` startup the server prints exactly one line to stderr: `[multi-model-agent] diagnostic log: <path>`. No new output for healthy users beyond that banner.

### Changed

- **`buildMcpServer` signature (breaking).** Now takes `(config, logger, options?)` — every in-repo caller and test helper updated in the same change. Tests that construct a server pass a no-op logger via `tests/tools/helpers.ts#makeNoopLogger()`.
- **`installStdioLifecycleHandlers` signature (breaking).** Now requires a `DiagnosticLogger` parameter; idempotent with a stderr warning on second install.

### Why

- End users reported "MCP dies every 1–2 calls" with no stack trace. The lifecycle handlers stop the silent crash on EPIPE; the logger captures the *cause* of the death so we can fix the actual root trigger in a follow-up release. Users on 2.7.3 who still hit disconnects can share `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` to make the cause visible.

## [2.7.2] - 2026-04-20

### Added

- **File artifact verification (core).** Tasks with `filePaths` containing non-existent paths (output targets) now verify those files exist after all work completes. If any output target is still missing, `status` downgrades from `ok` to `incomplete` and `fileArtifactsMissing` is set to `true`. Uses exact normalized path comparison via `fs.existsSync` against the final state (post-rework, post-commit).
- **Auto-commit (core).** New `autoCommit` field on `TaskSpec`. When true, the platform commits `filesWritten` via git after the worker finishes (and after each rework round). Commit message is derived from the worker's structured report summary. Uses `execFileSync` with argument arrays for shell safety. "Nothing to commit" is treated as a benign no-op. Commit SHA and any error are returned in `commitSha`/`commitError` on `RunResult`.
- **Preset auto-commit (mcp).** `delegate_tasks`, `execute_plan`, `debug_task`, and `retry_tasks` now set `autoCommit: true` by default. Read-only tools (`audit_document`, `review_code`, `verify_work`) do not.

### Changed

- **Delegation rule updated.** Plan auditing now routes through `review_code` (with plan + referenced source files) instead of `audit_document`, giving the auditor codebase access to validate type/function assumptions. Positive language throughout, rationale added for all rules, response handling reformatted as a table.

## [2.7.1] - 2026-04-19

### Fixed

- **Review verdicts feed into status (core).** Spec or quality review exhausting all rework rounds without approval now downgrades `status` from `ok` to `incomplete`. Previously, review verdicts were attached as metadata (`specReviewStatus`, `qualityReviewStatus`) but never influenced the top-level `status` field — callers saw `ok` for work that review rejected.
- **Spec reviewer catches partial edits (core).** The spec review prompt now includes a completeness instruction that checks whether each required target was adequately addressed. Flags `changes_required` only on positive evidence of omission (e.g., task names targets A, B, C but only A and B appear in modified files).

## [2.7.0] - 2026-04-19

### Added

- **Unified response envelope (mcp).** All 8 MCP tools (`delegate_tasks`, `retry_tasks`, `confirm_clarifications`, `audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) now return the same JSON shape: `{ headline, batchId, results: [{ status, output, filesWritten }] }`. Verbose telemetry fields (`usage`, `turns`, `escalationLog`, `agents`, `models`) are only available via `get_batch_slice`.
- **Auto-escape truncation (mcp).** Large outputs are truncated inline with a `[Output truncated...]` suffix pointing to `get_batch_slice`, replacing the old full/summary response mode split. Proportional budget allocation redistributes surplus from short outputs to long ones.
- **Plan-literal execution (core).** `execute_plan` compiler now instructs workers to follow the plan exactly as written, use code blocks verbatim, and not redesign or substitute their own approach.
- **Lenient review parsing (core).** `parseStructuredReport` now accepts `# Summary` (h1), `**Summary**` (bold), `Summary:` (colon), and plain first-paragraph as implicit summary — reducing review parse failures from format variation.
- **Review retry on parse failure (core).** `runSpecReview` and `runQualityReview` retry once with stronger format instructions when the first attempt produces an unparseable response.
- **Context block LRU-refresh (core).** Accessing a context block now resets its TTL, preventing frequently-used blocks from expiring mid-workflow.

### Changed

- **`get_batch_slice` simplified (mcp).** The `slice` parameter is removed. Now takes `{ batchId, taskIndex? }` and returns full telemetry + results. Error cases return content text instead of throwing.
- **`register_context_block` response simplified (mcp).** Returns `{ contextBlockId }` instead of the full registration metadata.
- **`responseMode` removed from `delegate_tasks` and `retry_tasks` (mcp).** The full/summary/auto mode selector is replaced by deterministic auto-escape truncation. Callers no longer choose a mode.
- **Default `maxReviewRounds` reduced from 10 to 5 (core).** Limits review cycles to 5 rounds across all review paths.

### Fixed

- **Audit compiler re-read instruction (core).** Delta audit prompts now instruct workers to re-read target files before comparing against prior findings, and begin with a findings count line.
- **Status promotion for shell-verified work (core).** Workers that self-report `done` and ran shell commands (e.g., `npm test`) are now promoted from `incomplete` to `ok`, even without `filesWritten`.
- **Context block error messages (core).** `ContextBlockNotFoundError` now includes recovery guidance: retry without `contextBlockIds` or re-register via `register_context_block`.
- **Heartbeat headline for specialized tools (mcp).** Specialized tools now emit `[task N] headline` format for progress notifications, matching `delegate_tasks`.

### Removed

- **Stall detection (core).** Removed `STALL_HEARTBEAT_THRESHOLD`, `setInFlight()`, `stallCount`, and the `stalled` field from `ProgressEvent`. The stall mechanism produced false positives and added complexity without actionable signal.
- **Old response builders (mcp).** Deleted `buildMetadataBlock`, `buildFanOutResponse`, `buildClarificationAwareResponse`, `shared-intake.ts`, and `clarification-response.ts` — all replaced by `buildUnifiedResponse`.

## [2.6.1] - 2026-04-19

### Fixed

- **Heartbeat progress notifications (mcp).** MCP progress notifications now send the human-readable `headline` string (e.g., `[1/5] Implementing (gpt-5.4) — 15s, 3 read, 0 written, 6 tool calls`) instead of a raw JSON dump of the full `ProgressEvent`. Clients that truncate the `message` field now display useful status instead of cut-off JSON.

## [2.6.0] - 2026-04-19

### Added

- **Progress event consolidation (core).** The 9-variant `ProgressEvent` discriminated union is replaced by a single heartbeat shape. The old union is renamed to `InternalRunnerEvent` for internal runner-to-orchestrator telemetry. HeartbeatTimer is the sole parent-facing emitter — runners keep emitting internal events, but `run-tasks.ts` intercepts them for live counter updates and stops forwarding to the parent.
- **Enriched heartbeat (core).** `ProgressEvent` now carries `provider` (current model name), `costUSD` / `savedCostUSD` (running cost with ROI), `final` (terminal marker), and `transition()` for atomic multi-field updates with stage invariant enforcement. Headline format: `[1/3] Implementing (claude-sonnet-4-6) — 10m 20s, $0.12 saved (4.2x), 4 read, 2 written, 12 tool calls`.
- **Dynamic stage count (core).** `stageCount` is computed from `reviewPolicy` at start: `off` → 1, `spec_only` → 3, `full` → 5. Semantic stage positions allow backward transitions on review re-entry (e.g. spec_rework → spec_review).
- **`hasFileArtifacts` in supervision (core).** `validateSubAgentOutput` now accepts `hasFileArtifacts` in its priority chain — when a worker self-reports `done` and has written files, the output is trusted even if it looks like a fragment. Reduces false-incomplete statuses.
- **Plan-aware spec reviewer (core, mcp).** For `execute_plan` tasks, the spec reviewer prompt now includes the matched plan section as `## Plan Context`, so the reviewer checks implementation against the plan — not just the brief summary.

### Changed

- **`ProgressEvent` is now heartbeat-only (core).** Breaking change for consumers that pattern-matched on `turn_start`, `tool_call`, `text_emission`, `turn_complete`, `injection`, `escalation_start`, `retry`, or `done` variants. Use `InternalRunnerEvent` for internal telemetry.
- **`HeartbeatTimer` API redesigned (core).** Constructor now requires `provider` and accepts optional `parentModel`. New methods: `transition()`, `setProvider()`, `updateCost()`. `stop()` is idempotent and emits a final flush with `final: true`. `setPhase()` removed.

## [2.5.0] - 2026-04-18

### Added

- **`context` field on `execute_plan` (mcp).** Optional string for short additional context the plan doesn't contain (e.g., "Tasks 1-16 are done, files already exist"). Injected into the worker prompt as `Additional context:`.

### Changed

- **Tool routing guidance clarified (mcp).** `delegate_tasks` description now explicitly states it is the general-purpose fallback — try specialized tools first (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`). `execute_plan` description clarifies: use when a plan file exists on disk; use `delegate_tasks` for ad-hoc work with no plan file.

## [2.4.4] - 2026-04-18

### Added

- **`execute_plan` specialized route (core, mcp).** New MCP tool that accepts task descriptors and plan/spec file paths — the worker reads the plan, finds the matching task heading, and implements it. Multiple tasks execute in parallel. Preset: standard agent, full review. Includes `ExecutePlanSource` type, route defaults, output contract, compiler with 8 tests, and full MCP tool handler.
- **Context block auto-registration (mcp).** All five specialized routes (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) now auto-register their output as a context block after execution and return the `contextBlockId` in metadata. Callers pass this ID directly as `contextBlockIds` in follow-up calls (e.g., round 2 of an audit) without calling `register_context_block` — eliminates redundant parent token spend on re-transmitting full output text.

## [2.4.3] - 2026-04-17

### Fixed

- **Saved-cost calculation in specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` resolved `parentModel` from config but never set it on the `TaskSpec` passed to the runner. The runner returned `savedCostUSD: null`, causing headlines to display `$0.00 saved` despite actual cost savings. All four tools now propagate `parentModel` into the task spec.

### Added

- **parentModel propagation tests (mcp).** 18 new tests across the four specialized tools covering `parentModel` flow into task specs, headline saved-cost display (single-task and fan-out), and headline actual-cost fallback when `parentModel` is absent.

## [2.4.2] - 2026-04-17

### Fixed

- **Headline with saved cost in specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` were missing the headline and `savedCostUSD` in their single-task and fan-out responses. Only `delegate_tasks` included them. All response paths now compose a headline via `composeHeadline` and include `savedCostUSD` in usage metadata, matching the `delegate_tasks` behavior.

## [2.4.1] - 2026-04-17

### Added

- **Saved-cost headline (mcp).** When `parentModel` is set in config defaults, the headline shows `$Y saved vs model (Zx ROI)` instead of `$X actual`. Without `parentModel`, the headline shows `$X actual` as before. `parentModel` is a single server-level config field (env var `PARENT_MODEL_NAME` or `defaults.parentModel`), not per-task.
- **12-provider model profiles (core).** Expanded from 5 flat entries to 30 profiles across Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Meta, Alibaba, Zhipu, Moonshot, Cohere, and MiniMax. Hierarchical prefix matching with inheritance — child profiles only override what changes from their parent.

### Changed

- **Model profiles JSON redesigned (core).** Restructured from flat array to provider groups with shared defaults, prefix inheritance, short field names (`input`/`output`/`cost`), and a `naming` field documenting each provider's model ID convention. The loader resolves inheritance at startup and validates every resolved profile against the existing Zod schema.
- **Headline simplified to one parent model (mcp).** Removed per-task `parentModel` and mixed-baselines logic. The headline now derives `parentModel` from server config, not from individual task specs.

## [2.4.0] - 2026-04-17

### Added

- **Delta audit mode (mcp).** `audit_document` automatically switches to delta mode when `contextBlockIds` is present — performs a full audit, verifies which prior findings were fixed, omits fixed findings from output, and ends with a fixed-findings summary.
- **Delta review mode (mcp).** `review_code` automatically switches to delta mode when `contextBlockIds` is present — same pattern as delta audit.
- **Context blocks in specialized tools (mcp).** All four preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now accept `contextBlockIds` directly, with the context block store threaded from the MCP server. No need to drop to `delegate_tasks` for context-aware workflows.
- **Model name in response (core, mcp).** New `models` field on `RunResult` with actual model names (e.g. `"MiniMax-M2.7"`) for `implementer`, `specReviewer`, `qualityReviewer`. Surfaced in full response, summary detail slice, fan-out response, and preset metadata blocks.

### Changed

- **Heartbeat elapsed format (core).** `elapsedMs: number` replaced with `elapsed: string` — human-readable format (`"50s"`, `"1m 30s"`) with 0 decimal places.
- **Default `briefQualityPolicy` changed from `'normalize'` to `'warn'` (core).** The `'normalize'` policy value is removed entirely since the normalizer was dead code.

### Removed

- **Normalizer (core).** Deleted `normalize-brief.ts`, `normalization-budget.ts`, and all threading: `normResult` parameter, `normalizationDecisions` field from structured reports, `normalizedPrompt` renamed to `prompt` in reviewer packets, `agents.normalizer` removed from response, `'normalize'` removed from `BriefQualityPolicy` and `ReadinessResult.action`.

## [2.3.0] - 2026-04-17

### Added

- **Progress heartbeats (core, mcp).** New `HeartbeatTimer` emits `{ kind: 'heartbeat', elapsedMs, turnsCompleted, phase }` events every 5 seconds during task execution, with phase transitions from `'implementing'` to `'reviewing'`. All preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now forward progress notifications to MCP clients via a shared `buildRunTasksOptions` helper.
- **`not_applicable` review status (core).** Tasks that produce no file artifacts (greetings, audits, read-only work) now return `specReviewStatus: 'not_applicable'` instead of sending empty packets to the reviewer that always errored on parse.
- **`specReviewReason` / `qualityReviewReason` fields (core, mcp).** Every non-`approved` review status now carries a human-readable reason string explaining why: `'reviewer output missing ## Summary section'`, `'task produced no file artifacts to review'`, `'skipped: reviewPolicy is off'`, etc. Surfaced in MCP response envelopes, detail slices, and preset metadata blocks.

### Fixed

- **Unsafe type casts removed in `confirm_clarifications` (mcp).** `registerConfirmClarifications` now accepts properly typed `TaskSpec[]`/`RunResult[]`/`RunTasksOptions` signatures instead of `unknown[]` with `as unknown as` casts. `RunTasksOptions` exported from core barrel.

## [2.2.0] - 2026-04-17

### Changed

- **Supervision thresholds relaxed (core).** `DEFAULT_MIN_LENGTH` reduced from 200 to 10, `MAX_DEGENERATE_RETRIES` from 10 to 3. Fragment detection restructured to run before the length auto-accept (capped at 120 chars) so real mid-work stalls are still caught while valid short responses pass immediately. Eliminates multi-minute hangs on simple tasks like greetings.
- **Preset tools bypass readiness and carry done conditions (mcp).** All four preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now set `briefQualityPolicy: 'off'` so the readiness layer never refuses internally-constructed briefs. Each tool also carries a purpose-specific `done` condition derived from its parameters (e.g., audit type, review focus, checklist length) so the worker has clear success criteria.

## [2.1.1] - 2026-04-17

### Changed

- **READMEs updated for 2.1.0 (root, core, mcp).** Tool count 8→9, `confirm_clarifications` added to tool tables, lifecycle diagram updated, version pin examples updated, `done` field description corrected, intake subpath exports added to core README.
- **Delegation rule made version-agnostic.** Removed version-specific references, reframed briefing guidance to reflect MCP interpretation model, simplified response handling, clarification handling integrated naturally into pipeline steps.

## [2.1.0] - 2026-04-17

### Added

- **Intake clarification pipeline (core, mcp).** Universal interpret-and-confirm pipeline across all MCP routes. The MCP compiles every request into a `DraftTask`, attempts to interpret it into a concrete execution plan, and either executes immediately or returns a proposed interpretation for the caller to confirm. Iterative — drafts bounce back until the MCP is confident enough to commit.
- **`confirm_clarifications` MCP tool (mcp).** New route for resuming clarification sets. Accepts edited drafts with replace-whole semantics, re-evaluates through the intake pipeline, executes ready drafts, and bounces back unclear ones. Supports partial confirmation, round tracking, duplicate-reason detection, and 6 distinct error codes.
- **Route compilers (core).** Five route-specific compilers (`compileDelegateTasks`, `compileReviewCode`, `compileDebugTask`, `compileVerifyWork`, `compileAuditDocument`) that produce `DraftTask[]` with output-contract clauses, fan-out for multi-file routes, and source preservation.
- **Classification heuristic (core).** Deterministic classifier with three outcomes: `ready`, `needs_confirmation`, `unrecoverable`. Preset routes get content-quality checks (not structural checks). Confirmed drafts skip ambiguity criteria.
- **Clarification store (core).** In-memory TTL/LRU store for clarification sets with eager cleanup, round tracking, and per-draft lifecycle management.
- **`intakeProgress` on batch responses (mcp).** New field on all `delegate_tasks` responses showing `totalDrafts`, `readyDrafts`, `clarificationDrafts`, `hardErrorDrafts`, `executedDrafts`.
- **`clarifications` array on batch responses (mcp).** When tasks need confirmation, the response includes proposed interpretations with assumptions and questions.

### Changed

- **`schemaVersion` bumped to `2.1.0` (mcp).** All `delegate_tasks` responses now include `intakeProgress`. Responses with unclear tasks include `clarifications` and `clarificationId`.
- **Legacy normalizer removed (core).** The model-based `normalizeBrief()` call is replaced by a passthrough stub. Write-set derived from `filePaths`. The model call is fully removed; only the `NormalizationResult` shape remains for the review pipeline.
- **Readiness reduced to invariant check (core).** Tasks from the intake pipeline (`briefQualityPolicy: 'off'`) skip readiness entirely. Legacy readiness runs only for non-intake code paths during migration.

## [2.0.1] - 2026-04-16

### Fixed

- **`delegate_tasks` `done` field guidance corrected (core, mcp, docs).** The `done` field is a required acceptance-criteria signal, not a "prefer" hint — the readiness checker treats `TaskSpec.done` as satisfying the `done_condition` pillar. Three doc locations corrected: `packages/mcp/src/cli.ts:310` description, `packages/mcp/README.md:80` table entry, and `docs/claude-code-delegation-rule.md:55`.

## [2.0.0] - 2026-04-16

### Breaking Changes

- **`maxTurns` removed from config defaults (core).** Time and cost bounds replace turn limits. New defaults: `timeoutMs: 1_800_000` (30 min), `maxCostUSD: 10`.
- **`status: 'max_turns'` replaced by `'incomplete'` + `errorCode: 'degenerate_exhausted'` (core).** All runners emit structured incomplete statuses instead of a bare `max_turns` status.
- **TaskSpec stripped to task-signal fields (core).** Removed `maxTurns`, `skipCompletionHeuristic`, and internal fields from public surface. Added `done?: string` (acceptance criteria) and `filePaths?: string[]` (focus scope). `contextBlockIds` promoted to caller-facing.
- **MCP tool schemas simplified (mcp).** Specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now expose only their domain fields + `filePaths`. Internal config fields (`cwd`, `tools`, `timeoutMs`, etc.) resolved by the harness from config, not caller-supplied. `applyCommonFields` removed.

### Changed

- **Prevention prompts now time/cost-based (core).** `buildBudgetHint` now takes `{ timeoutMs, maxCostUSD? }` instead of `{ maxTurns }`. `buildReGroundingMessage` takes `{ elapsedMs, timeoutMs, toolCallsSoFar, filesReadSoFar }` instead of `{ currentTurn, maxTurns, ... }`.
- **Supervision rewritten as monitor model (core).** Gatekeeper pattern replaced by monitor pattern. Loop detection and stall detection are advisory (inject re-grounding, don't terminate). `MAX_SUPERVISION_RETRIES` removed; `MAX_DEGENERATE_RETRIES = 10` governs retry budget. Only counts as degenerate when a turn has no tool calls.
- **`doneCondition` wired to `task.done` (core).** The spec reviewer prompt now shows the caller's acceptance criteria instead of hardcoded `'tsc passes'`. The worker's initial prompt also receives `task.done` as `## Success Criteria` so the worker itself is guided by the caller's acceptance criteria.
- **`briefQualityPolicy` transparent default is `normalize` (core).** Vague briefs are auto-normalized rather than surfaced with a warning. Previously defaulted to `'warn'` which surfaced vague briefs instead of normalizing them.
- **`review_rounds` transparent default is plateau detection (core).** Review continues until the reviewer approves, the same findings appear in two consecutive rounds, or the safety limit is reached. Previously hard-capped at `maxReviewRounds ?? 2` which was arbitrary.
- **`filePaths` is a soft completion signal (core).** Review is no longer skipped when `filesWritten` is empty. The harness tracks whether the worker read or wrote any `task.filePaths` and exposes it as `filePathsSkipped` in the result. Previously the review was skipped entirely when no files were written.
- **`retry_tasks` now re-injects fresh defaults (mcp).** Previously retried tasks ran with raw cached task specs. Now `retry_tasks` applies the same default injection as `delegate_tasks` (`tools`, `timeoutMs`, `maxCostUSD`, `sandboxPolicy`, `cwd`, `reviewPolicy`) so retries get current config values.

### Added

- **`done?: string` on TaskSpec (core, mcp).** Callers can specify acceptance criteria in plain language. Included in the worker's prompt as `## Success Criteria` and passed to the spec reviewer as `doneCondition`. Falls back to `'tsc passes'` when not provided.
- **`filePaths?: string[]` on TaskSpec (core, mcp).** Files the sub-agent should focus on. Used by specialized tools for prompt injection (`buildFilePathsPrompt`) and fan-out dispatch. The generic execution path tracks whether the worker interacted with these files as a soft completion concern (`filePathsSkipped` on `RunResult`).

## [1.3.0] - 2026-04-15

### Added
- **`no-shell` tool mode (core).** New `ToolMode` value `'no-shell'` enables all file tools (read, write, edit, grep, glob) while blocking shell access. Use for tasks with untrusted prompt content.
- **`TerminationReason` on `RunResult` (core).** Structured field reporting why a task stopped (`cause`), turn usage (`turnsUsed`/`turnsAllowed`), artifact evidence (`hasFileArtifacts`, `usedShell`), worker self-assessment, and whether status was promoted. Replaces the need to cross-reference multiple fields.
- **Shell usage guidance in worker system prompt (core).** Workers receive clear rules: use `run_shell` for tests, builds, and command-line tasks; use `edit_file`/`write_file` for file modifications; run targeted tests in parallel.

### Changed
- **`sandboxPolicy: 'cwd-only'` no longer blocks shell (core).** File tools remain confined to the cwd tree. Shell commands (`run_shell`) now execute freely under `cwd-only` — controlled by `tools` mode instead. Previously, `cwd-only` blocked both file paths and shell access. Callers who relied on shell blocking must switch to `tools: 'no-shell'`.
- **Completion detection redesign (core).** `FILE_MUTATING_TOOLS` renamed to `COMPLETED_WORK_TOOLS`, now includes `runShell`. `validateSubAgentOutput` accepts `workerStatus` and `hasCompletedWork` as explicit signals. `workerStatus: 'done'` with work evidence is trusted. Promotion logic recognizes shell-only tasks with substantive output.
- **`workerStatus` internalized (core, mcp).** Removed from MCP response surfaces (delegate_tasks, fan-out, metadata block, batch slice). Use `terminationReason.workerSelfAssessment` instead. Still available internally for escalation logic.
- **Field descriptions simplified (mcp).** All 15+ `buildTaskSchema()` field descriptions and 4 specialized tool descriptions rewritten. One-line-first pattern replaces verbose WHAT/WHEN/DEFAULT/INTERACTION format.
- **Worker system prompt rewritten for clarity (core).** Restructured into Tool rules, Shell rules, Progress and completion sections. All instructions are direct and unambiguous.

## [1.2.1] - 2026-04-14

### Added
- **`edit_file` steering in sub-agent system prompt (core).** Workers are now guided to prefer `edit_file` for partial modifications instead of `write_file` (full rewrite) or `run_shell` with sed/awk (error-prone). Added to the "Tool efficiency rules" section of `buildSystemPrompt()` in `prevention.ts`.
- **`maxCostUSD` on all specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` now accept an optional `maxCostUSD` parameter, passed through to `runTasks()` via `commonToolFields` and `applyCommonFields()`. Callers can budget individual audits and reviews.
- **`escalationLog` and `agents` in single-task metadata (mcp).** `buildMetadataBlock()` now includes `escalationLog` (provider attempt chain) and `agents` (which agent ran each lifecycle role). Previously only available in fan-out mode via `buildFanOutResponse()`.

## [1.2.0] - 2026-04-13

### Added
- **`edit_file` tool for surgical edits (core).** New tool that replaces a unique string match in an existing file, wired into all three adapters (OpenAI, Claude, Codex). Requires `oldContent` to match exactly one location.
- **Effort inference from task prompt shape (core).** `inferEffort()` auto-selects effort level (`none`/`low`/`medium`/`high`) based on prompt characteristics when not explicitly declared.
- **Parallel-safe build instructions (core).** Concurrent tasks receive guidance to use targeted test commands instead of full-project builds.
- **Auto-retry transient errors (core).** `api_error`, `network_error`, and `timeout` statuses trigger automatic retry with exponential backoff (up to 2 retries).
- **`incomplete` → `ok` promotion (core).** When `workerStatus` is `done` and file artifacts exist, tasks are promoted from `incomplete` to `ok`.
- **`hasCompletedWork` flag (core).** Supervision skips stylistic heuristics (fragment, no-terminator) after file writes, reducing false-positive `incomplete` statuses.
- **Auto-skip review when no artifacts (core).** Review pipeline is skipped when the task produced no file artifacts, saving review budget.
- **Tool-use efficiency rules in system prompt (core).** Sub-agents receive guidance on avoiding redundant file reads, batching grep patterns, and preferring grep over readFile.

### Changed
- **Review status types (core).** `'not_run'` replaced with `'skipped'`/`'error'` for clearer semantics.
- **`retry_tasks`, `maxCostUSD`, and context block descriptions improved (mcp).** Clearer WHAT/WHEN/DEFAULT/INTERACTION documentation on MCP tool parameters.

## [1.1.0] - 2026-04-13

### Added
- **`readonly` tool mode (core).** New `ToolMode` value `'readonly'` enables read-only filesystem access (readFile, grep, glob, listFiles) while blocking writes and shell. Hosted tools (web_search, WebSearch/WebFetch) remain enabled in readonly mode. All three runners (OpenAI, Claude, Codex) and both adapters support readonly filtering.
- **Platform parity for specialized tools (mcp).** All 4 specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now accept `filePaths`, `cwd`, `contextBlockIds`, and `tools` parameters. Each returns a metadata block with usage, status, files touched, and tool calls.
- **Fan-out parallel dispatch.** When specialized tools receive multiple `filePaths` without inline content, each file becomes a separate parallel task via `runTasks()`. Response uses a dedicated `fan_out` envelope (no batchId — not cache-backed).
- **`auditType` accepts array and `'general'`.** `audit_document` now accepts `['security', 'correctness']` or `'general'` (all four categories). `review_code` gains `outputFormat` parameter.
- **`verify_work` enforces `checklist.min(1)`.**
- **Shared tool infrastructure (mcp).** New internal modules: `shared.ts` (commonToolFields, dispatch logic, metadata builder, prompt helpers) and `batch-response.ts` (extracted from cli.ts).

### Changed
- **`delegate_tasks` description** now includes routing guidance for specialized tools.
- **`buildTaskSchema` tools enum** updated to `'none' | 'readonly' | 'full'`.
- **`debug_task` preset** now explicitly sets `reviewPolicy: 'full'` (was implicit via default).
- **Batch response builders** extracted from cli.ts into batch-response.ts. Re-exported from cli.ts for backward compatibility.

### Removed
- **`execute_plan_task` tool.** Subsumed by `delegate_tasks` with a single-element task array. Source, tests, registration, and package export all removed.

### Documentation
- **READMEs rewritten.** Marketing-first structure with savings table, quick start, collapsible details. MCP and core READMEs are complementary (no duplication).
- **Delegation rule rewritten.** Auto-pipeline for superpowers users (3 spec audit rounds, 2 plan audit rounds, automatic implementation + review). Standalone usage for non-superpowers users. 124 lines, imperative style.

## [1.0.0] - 2026-04-12

**Breaking rewrite from v0.4.0.** The config schema, tool surface, task fields, and lifecycle have all changed. See the migration table at the end of this entry.

### New Features

- **Reviewed lifecycle (core).** Every task now passes through a five-phase lifecycle: `Brief → Readiness check → Dispatch → Execute → Review (if enabled) → Aggregate`. The readiness check (`normalizeBrief`) evaluates prompt quality before any money is spent — it surfaces vague scopes, overambitious dispatches, and missing context before the worker runs.
- **Specialized tools (mcp).** Four tools beyond basic batch dispatch:
  - `audit_document` — verify a spec document's requirements are met
  - `debug_task` — triage a failure against known failure patterns
  - `review_code` — structural quality review of a diff or module
  - `verify_work` — confirm implementation matches spec
- **Two-slot agent model (core).** Tasks declare `agentType: "standard"` (fast, cheap, capability-gated) or `agentType: "complex"` (slower, reasoning) instead of `tier`. Auto-routing selects the cheapest configured agent satisfying the required capabilities and declared `agentType`.
- **Cost ceiling (core).** Each task can declare a `maxCostUSD` that aborts execution before spending beyond the threshold. Prevents runaway dispatches on ambiguous tasks.
- **Call cache (core).** Repeated identical calls (same prompt + model hash) return the cached result within a sliding window, avoiding redundant spend on retry paths.
- **Format constraints (core).** `expectedCoverage` declared per task enforces structured output requirements — `minSections`, `sectionPattern`, `requiredMarkers`. The supervision layer re-prompts on missing items and classifies thin responses as `insufficient_coverage`.
- **Structured errors (core).** Per-task status is now one of ten protocol values: `ok`, `incomplete`, `max_turns`, `timeout`, `api_aborted`, `api_error`, `network_error`, `error`, `brief_too_vague`, `cost_exceeded`. All ten surface the best-effort scratchpad into `output` before returning.
- **`schemaVersion` field (mcp).** Every response envelope carries `schemaVersion: "1.0.0"` so callers can branch on the schema shape without relying on version checks.

### Breaking Changes

- **`config.providers` → `config.agents`** (core). The top-level config key is now `agents`, reflecting the two-slot model. Provider entries inside `agents` use `provider` to name the underlying API type (`openai-compatible`, etc.).
- **`task.tier` → `task.agentType`** (core). `trivial`/`standard`/`reasoning` tiers are replaced by `agentType: "standard"` or `agentType: "complex"`. Standard maps roughly to `standard`; complex maps roughly to `reasoning`. `trivial` is now just `agentType: "standard"` with no special routing treatment.
- **`get_task_output`, `get_task_detail`, `get_batch_telemetry` → `get_batch_slice`** (mcp). Three fetch tools are consolidated into one. `get_batch_slice(batchId, slice)` where `slice` is `"output"`, `"detail"`, or `"telemetry"`.
- **`progressTrace` removed** (core). The bounded execution timeline capture is replaced by structured `AttemptRecord[]` entries in `get_batch_slice(..., "detail")`. `initialPromptHash` provides cross-runner stable identification of identical briefs.
- **`hostedTools` narrowed for `openai-compatible`** (core). Only `web_search` is available by default for openai-compatible providers. Other tools (`image_generation`, `code_interpreter`) require explicit opt-in.
- **`BatchAggregateCost` trimmed** (mcp). `actualCostUnavailableTasks` and `savedCostUnavailableTasks` are removed. The aggregate cost shape is now: `totalActualCostUSD`, `totalSavedCostUSD`.

### Migration: v0.4.0 → v1.0.0

| v0.4.0 | v1.0.0 | Notes |
|---|---|---|
| `config.providers` | `config.agents` | Config top-level key renamed |
| `task.tier: "trivial"\|"standard"\|"reasoning"` | `task.agentType: "standard"\|"complex"` | Tier replaced by two-slot agentType |
| `get_task_output(batchId, taskIndex)` | `get_batch_slice(batchId, "output", { taskIndex })` | Consolidated into one tool |
| `get_task_detail(batchId, taskIndex)` | `get_batch_slice(batchId, "detail", { taskIndex })` | Consolidated into one tool |
| `get_batch_telemetry(batchId)` | `get_batch_slice(batchId, "telemetry")` | Consolidated into one tool |
| `progressTrace` field | Removed | Use `get_batch_slice(..., "detail")` for `AttemptRecord[]` |
| `hostedTools: ["web_search", ...]` on openai-compatible | Only `web_search` available by default | Others require explicit opt-in |
| `BatchAggregateCost.actualCostUnavailableTasks` | Removed | — |
| `BatchAggregateCost.savedCostUnavailableTasks` | Removed | — |
| `delegate_tasks` with `responseMode: "full"` | `responseMode: "full"` unchanged | Full mode shape preserved |
| `delegate_tasks` with `responseMode: "summary"` | `responseMode: "summary"` unchanged | Summary shape preserved, but fetch tools consolidated |
| `tier: "reasoning"` + `effort: "high"` | `agentType: "complex"` | No effort change; agentType drives routing |
| `expectedCoverage` with `requiredMarkers` | `expectedCoverage` with `requiredMarkers` | Unchanged |
| `skipCompletionHeuristic` | `skipCompletionHeuristic` | Unchanged |
| `contextBlockIds` | `contextBlockIds` | Unchanged |
| `retry_tasks(batchId, taskIndices)` | `retry_tasks(batchId, taskIndices)` | Unchanged |
| `register_context_block(id, content)` | `register_context_block(id, content)` | Unchanged |

### New Tools Summary

| Tool | When to use it |
|---|---|
| `delegate_tasks` | Main batch dispatch; auto-routes to standard or complex slot |
| `register_context_block` | Store long briefs or evidence bundles once, reference by id |
| `retry_tasks` | Re-dispatch specific tasks from a batch |
| `get_batch_slice` | Fetch output/detail/telemetry from a previous batch |
| `audit_document` | Spec compliance audit |
| `debug_task` | Failure triage against known patterns |
| `review_code` | Structural code quality review |
| `verify_work` | Implementation vs spec verification |

## [0.4.0] - 2026-04-11

Both `@zhixuan92/multi-model-agent-core` and `@zhixuan92/multi-model-agent-mcp` bump to `0.4.0` in lockstep. Core picks up a supervision-layer fix and a new `TaskSpec` field; MCP ships the ROI headline and two new telemetry tools.

### Added

- **ROI headline on every `delegate_tasks` response (mcp).** New `headline` field at the top of both `full` and `summary` mode envelopes — a pre-computed one-line summary of tasks / success rate / wall-clock / serial savings / actual cost / saved cost / ROI multiplier. The calling agent quotes it verbatim with no arithmetic. When a single `parentModel` is declared across the batch, the headline includes a full cost-savings clause with an `Nx ROI` multiplier. When tasks declare different parent models (mixed baselines), the multiplier is suppressed and the clause reads `$X actual / $Y saved vs multiple baselines` — the `$saved` number is still a valid additive dollar quantity but a single ratio across different baselines is not coherent and is deliberately not emitted.
- **`get_batch_telemetry(batchId)` MCP tool (mcp).** Returns a compact envelope with `headline`, `timings`, `batchProgress`, `aggregateCost`, and a per-task cost/timing rollup. Envelope size is a constant ~600-byte header plus ~200 bytes per task, so a typical 10–30-task batch comes back at 2–7 KB (well under any client-side tool-result size limit); batches approaching 200+ tasks scale linearly and may approach the limit. Use as a single-call escape hatch when the primary `delegate_tasks` response came back in explicit `full` mode and the client-side size limit obscured the envelope. Timings are recomputed from the cached `results[]` with `wallClockMs ≈ max(durationMs)` as a lower-bound estimate — the batch cache shape is not modified.
- **`get_task_detail(batchId, taskIndex)` MCP tool (mcp).** Returns the bulky per-task fields (`toolCalls: string[]`, `filesRead`, `filesWritten`, `directoriesListed`, full `escalationLog` with `reason` strings, `progressTrace` when opted in) that were moved out of summary mode. Use when you need to inspect what a specific task actually did — debug a failure, verify file-write scope, or review the provider escalation chain.
- **`escalationChain: string[]` field on summary-mode `results[]` entries (mcp).** A one-line representation of the provider walk formatted as `<provider>:<status>` per attempt. Examples: `["minimax:ok"]` for a one-shot task, `["minimax:incomplete","codex:ok"]` for a walked chain, `["minimax:error","codex:api_error","claude:timeout"]` for an all-failed task. The full `AttemptRecord[]` with `reason` strings is available via `get_task_detail`.
- **`TaskSpec.skipCompletionHeuristic?: boolean` (core + mcp).** Opt-out field for tasks whose expected output is short and structured (single-line verdicts, CSV rows, opaque identifiers) and would trip the runner's default `no_terminator` / `fragment` short-output heuristic. When `true`, those two degeneracy checks are skipped; `empty` and `thinking_only` still fire. Exposed in the MCP `delegate_tasks` Zod schema as an optional boolean.
- **`validateSubAgentOutput(text, opts)` coordinator (core).** New exported helper in `packages/core/src/runners/supervision.ts` that runs `empty`/`thinking_only` → `expectedCoverage` → `skipCompletionHeuristic` → default short-output heuristic in the correct priority order. The existing `validateCompletion` and `validateCoverage` functions are unchanged internally — the coordinator wraps them.

### Changed (BREAKING)

- **`delegate_tasks` `summary`-mode `results[]` shape is slimmed (mcp).** The per-task entries no longer carry `toolCalls`, `filesRead`, `filesWritten`, `directoriesListed`, `progressTrace`, or the full `escalationLog[].reason` strings inline. Call `get_task_detail({ batchId, taskIndex })` for those fields. The rename from `_fetchWith` → `_fetchOutputWith` is part of the same breaking change; a new `_fetchDetailWith` sibling points at `get_task_detail`. Full mode (`responseMode: "full"`) is unchanged — every existing per-task field still appears inline. Only summary mode's `results[]` shape changed.

### Fixed

- **Supervision false-positive on tight-format outputs (core).** When a task declared `expectedCoverage` AND the output satisfied the coverage contract, the runner was previously re-prompting anyway if the output was short and lacked terminal punctuation — the generic `no_terminator` heuristic fired before the more authoritative coverage check had a chance to run. Result: correct-but-tight outputs (e.g., `"verdict: pass, 5 sections found"`) were landing as `status: incomplete`. The priority is now inverted: `expectedCoverage`, when declared, is authoritative. Coverage pass → output is valid, short-output heuristics are skipped. `empty` and `thinking_only` still fire regardless. Affects all three runners (`openai-runner.ts`, `claude-runner.ts`, `codex-runner.ts`).

### Migration

- If your code reads `results[i].toolCalls` / `filesRead` / `filesWritten` / `directoriesListed` / `progressTrace` from a summary-mode response, replace it with a `get_task_detail({ batchId, taskIndex: i })` call and read the same field from the detail response.
- If you need the full escalation `reason` strings (debugging provider walks, auditing which worker failed on what), call `get_task_detail` and read `.escalationLog[j].reason`. For a compact one-line view of which providers were attempted, use the new `escalationChain` field directly on the summary entry.
- If you built follow-up `get_task_output` calls from `results[i]._fetchWith`, rename to `_fetchOutputWith`. Semantically identical, just a new key name.
- If you call `delegate_tasks` with explicit `responseMode: "full"` and hit a client-side tool-result size limit that obscures the response, call `get_batch_telemetry({ batchId })` afterward to get the ROI envelope in a bounded-small response. The `headline` field is still emitted at the top of full-mode responses and is visible whenever the envelope fits.
- If your delegation flow includes tight-format tasks (single-line verdicts, CSV rows, opaque identifiers) and you were seeing false-positive `incomplete` statuses, either declare `expectedCoverage` with `requiredMarkers` that identify the shape of a valid output, or set `skipCompletionHeuristic: true` on the task spec. Prefer `expectedCoverage` when the output is enumerable — it's more authoritative and catches more bug shapes.

## [0.1.2] - 2026-04-10

Patch release: `@zhixuan92/multi-model-agent-mcp` to `0.1.2` and
`@zhixuan92/multi-model-agent-core` to `0.1.1`.

### Fixed

- **core, mcp**: `@openai/agents` and `openai` were declared as
  *optional* peer dependencies, so npm/npx never installed them
  alongside the published packages. End users running
  `npx @zhixuan92/multi-model-agent-mcp serve` saw the codex and
  openai-compatible runners crash on first dispatch with
  `Cannot find package 'openai'` / `Cannot find package
  '@openai/agents'`. The local dev workspace masked the bug because
  both libraries lived in the root `devDependencies` and were hoisted
  into `node_modules`. Both libraries are now regular `dependencies`
  of `@zhixuan92/multi-model-agent-core` (the only package whose
  source code imports them); `@zhixuan92/multi-model-agent-mcp`
  receives them transitively and no longer declares the peer block.

## [0.1.1] - 2026-04-10

Patch release for `@zhixuan92/multi-model-agent-mcp` only.
`@zhixuan92/multi-model-agent-core` remains at `0.1.0`.

### Fixed

- **mcp**: `dist/cli.js` is now executable (`chmod +x` after `tsc`),
  and a `prepublishOnly` hook runs the build before every publish.
  In `0.1.0` the file was emitted with mode `0644`, which caused
  `npm publish` to silently strip the `bin` entry from the published
  manifest with the warning `"bin[multi-model-agent]" script name
  dist/cli.js was invalid and removed`. The result was a published
  package with no `multi-model-agent` command, breaking
  `npx @zhixuan92/multi-model-agent-mcp serve` and the global install
  path. `0.1.0` has been deprecated; please use `0.1.1` or later.

## [0.1.0] - 2026-04-10

Initial public release.

### Added

#### MCP server
- `delegate_tasks` MCP tool that runs an array of tasks concurrently across configured providers, returning a result per task with status, output, token usage, turn count, and the list of files written.
- Auto-routing: when a task omits `provider`, the server picks the cheapest configured provider that satisfies the task's `requiredCapabilities` and `tier`. Tie-breaks by provider name.
- Live routing matrix in the MCP tool description so the orchestrating model sees provider names, model ids, supported tools, quality tier, effective cost tier, and `effort` support based on the loaded config.
- Stdio transport via `multi-model-agent serve` (or `npx @zhixuan92/multi-model-agent-mcp serve`).
- Config discovery in this order: `--config <path>` argument, `MULTI_MODEL_CONFIG` environment variable, `~/.multi-model/config.json`.

#### Provider runners
- **Claude** runner using `@anthropic-ai/claude-agent-sdk`. Supports `effort` (`none` / `low` / `medium` / `high`), built-in `WebSearch` / `WebFetch`, and a custom MCP code-tools server for file/grep/glob operations.
- **Codex** runner using the OpenAI Responses API against the `chatgpt.com/backend-api/codex` endpoint when `codex login` credentials are present, falling back to `OPENAI_API_KEY` against the public OpenAI API. Supports `effort`, hosted `web_search`, and the multi-turn function-call loop.
- **OpenAI-compatible** runner using `@openai/agents` (optional peer). Pointed at any OpenAI-compatible base URL via `baseUrl` plus `apiKey` or `apiKeyEnv`.

#### Capabilities and routing
- Capability matrix per provider: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`.
- Quality tiers: `trivial`, `standard`, `reasoning`. Tier filtering uses model profiles in `packages/core/src/routing/model-profiles.json`.
- Cost tiers: `free`, `low`, `medium`, `high`. `costTier` in provider config overrides the model-profile default and is shown as `(from config)` in the routing matrix.
- Per-task `tools` and `sandboxPolicy` overrides.

#### Tool sandbox
- Default `sandboxPolicy: cwd-only` confines `readFile`, `writeFile`, `grep`, `glob`, and `listFiles` to the task's `cwd`. Path traversal and symlinks pointing outside `cwd` are rejected via `fs.realpath` resolution.
- `runShell` is hard-disabled under `cwd-only` and only available when `sandboxPolicy: none` is set explicitly per-provider or per-task.
- File size caps to prevent host OOM / disk-fill: `readFile` rejects targets larger than 50 MiB, `writeFile` rejects content larger than 100 MiB. Both are checked **before** allocating memory or touching disk.

#### Configuration
- Zod-validated config schema for providers and defaults. All numeric limits (`maxTurns`, `timeoutMs`) must be positive integers.
- `apiKeyEnv` pattern for storing secrets in environment variables instead of inline in the config file. The server emits a warning at config-load time if an inline `apiKey` is found.
- `effort` and `hostedTools` per provider with sensible defaults (Codex auto-enables `web_search` unless `hostedTools` is explicitly set).

#### Security defenses
- One-time stderr warning when `~/.codex/auth.json` is group- or world-readable, with a `chmod 600` hint. Skipped on Windows.
- One-time stderr warning at module load when `CODEX_DEBUG=1` is set, since debug mode logs raw request/response bodies (prompts, file contents) to stderr.
- Per-task and per-provider `timeoutMs` and `maxTurns` enforcement via the `withTimeout` wrapper and an `AbortController` plumbed into all runners.

#### Packaging
- Monorepo split into two publishable packages:
  - `@zhixuan92/multi-model-agent-core` — runtime library (routing, config, runners, tool sandbox).
  - `@zhixuan92/multi-model-agent-mcp` — MCP stdio server binary.
- ESM-only, Node `>= 22`.
- `@openai/agents` and `openai` are optional peer dependencies — only required for `openai-compatible` providers.

#### Tests
- 220 Vitest tests across 20 files covering config schema, routing eligibility and selection, provider dispatch, all three runners (with `vi.mock`'d SDKs and a regression test for the multi-turn replay bug fixed in this release), tool sandbox boundaries, MCP CLI config discovery, package export contracts, and the file-size guards.

[4.0.4]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.3...v4.0.4
[4.0.3]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.2...v4.0.3
[4.0.2]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.1...v4.0.2
[4.0.1]: https://github.com/zhixuan312/multi-model-agent/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.7...v4.0.0
[3.12.7]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.6...v3.12.7
[3.12.6]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.5...v3.12.6
[3.12.5]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.4...v3.12.5
[3.12.4]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.3...v3.12.4
[3.12.3]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.2...v3.12.3
[3.12.2]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.1...v3.12.2
[3.12.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.12.0...v3.12.1
[3.12.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.11.1...v3.12.0
[3.11.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.11.0...v3.11.1
[3.11.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.7...v3.11.0
[3.10.7]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.6...v3.10.7
[3.10.6]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.5...v3.10.6
[3.10.5]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.4...v3.10.5
[3.10.4]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.3...v3.10.4
[3.10.3]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.2...v3.10.3
[3.10.2]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.1...v3.10.2
[3.10.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.10.0...v3.10.1
[3.10.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.9.1...v3.10.0
[3.9.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.9.0...v3.9.1
[3.9.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.8.1...v3.9.0
[3.8.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.8.0...v3.8.1
[3.8.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.7.0...v3.8.0
[3.7.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.6.7...v3.7.0
[3.6.7]: https://github.com/zhixuan312/multi-model-agent/compare/v3.6.6...v3.6.7
[3.6.6]: https://github.com/zhixuan312/multi-model-agent/compare/v3.6.5...v3.6.6
[3.6.5]: https://github.com/zhixuan312/multi-model-agent/compare/v3.6.4...v3.6.5
[3.6.4]: https://github.com/zhixuan312/multi-model-agent/compare/v3.6.3...v3.6.4
[3.5.1]: https://github.com/zhixuan312/multi-model-agent/compare/v3.5.0...v3.5.1
[3.5.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/v3.2.0...v3.3.0
[2.8.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.5...mcp-v2.8.0
[2.7.5]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.4...mcp-v2.7.5
[2.7.4]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.3...mcp-v2.7.4
[2.7.3]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.2...mcp-v2.7.3
[2.7.2]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.1...mcp-v2.7.2
[2.7.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.0...mcp-v2.7.1
[2.7.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.6.1...mcp-v2.7.0
[2.6.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.6.0...mcp-v2.6.1
[2.6.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.5.0...mcp-v2.6.0
[2.5.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.4...mcp-v2.5.0
[2.4.4]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.3...mcp-v2.4.4
[2.4.3]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.2...mcp-v2.4.3
[2.4.2]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.1...mcp-v2.4.2
[2.4.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.0...mcp-v2.4.1
[2.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.3.0...mcp-v2.4.0
[2.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.2.0...mcp-v2.3.0
[2.2.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.1.1...mcp-v2.2.0
[2.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.1.0...mcp-v2.1.1
[2.1.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.0.1...mcp-v2.1.0
[2.0.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.0.0...mcp-v2.0.1
[2.0.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.3.0...mcp-v2.0.0
[1.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.2.1...mcp-v1.3.0
[1.2.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.2.0...mcp-v1.2.1
[1.2.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.1.0...mcp-v1.2.0
[1.1.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.0.0...mcp-v1.1.0
[1.0.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.4.0...mcp-v1.0.0
[0.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.3.1...mcp-v0.4.0
[0.1.2]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhixuan312/multi-model-agent/releases/tag/v0.1.0
