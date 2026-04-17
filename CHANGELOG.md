# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.2.0...HEAD
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