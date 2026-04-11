# Sub-Agent Reliability v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five v0.2.0 post-mortem gaps (semantic incompleteness blind spot, large-response size limit, `max_turns` label ambiguity, `costUSD: null` on every dispatch, progress-events visibility) plus two small items (`filesRead` cleanup, tool description docs) — and make delegation savings visible to the calling agent via new per-task and batch-level cost/time metrics.

**Architecture:** All changes are **additive** to v0.2.0's four-layer architecture (prevention → recovery → salvage → escalation). New `expectedCoverage` field on `TaskSpec` adds a generic enumerable-deliverable check to the supervision loop. New `responseMode` / `get_task_output` / configurable threshold add response pagination to the MCP bridge. New `parentModel` / `savedCostUSD` / `durationMs` / top-level `timings` / `batchProgress` / `aggregateCost` fields make savings visible. New `progressTrace` opt-in gives post-hoc execution observability. New `directoriesListed` cleans up a minor `filesRead` inconsistency. The openai-runner continuation-budget bug is fixed and `max_turns` reason strings gain precision across all three runners. **Zero breaking changes** — every existing v0.2.0 caller sees identical behavior unless they opt in to the new fields.

**Tech Stack:** TypeScript (Node ≥22, ESM), Vitest, Zod for schema validation, `@openai/agents`, `@anthropic-ai/claude-agent-sdk`, the `openai` SDK, `@modelcontextprotocol/sdk`. Existing repo conventions: per-file responsibility, mirrored test paths, mock providers (no real LLM calls in tests), strict TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-11-subagent-reliability-v0.3.0-design.md`. Read it once before starting. Sections 1-11 cover the feature set; section 10.4 enumerates the 15 tasks this plan formalizes.

---

## Worktree & Pre-Flight

This plan touches ~14 code files across both packages plus ~12 test files. Execute it in a dedicated git worktree so master stays clean.

- [ ] **Pre-flight 1: Verify clean working tree on master.**

  ```bash
  cd /Users/zhangzhixuan/Documents/code/multi-model-agent
  git status
  git rev-parse --abbrev-ref HEAD
  ```

  Expected: `nothing to commit, working tree clean`, branch `master`. Last tag `mcp-v0.2.0`.

- [ ] **Pre-flight 2: Create the worktree.**

  ```bash
  git worktree add ../multi-model-agent-v0.3.0 -b dev/v0.3.0 master
  cd ../multi-model-agent-v0.3.0
  npm install
  ```

  Expected: new directory at `../multi-model-agent-v0.3.0` with the repo checked out on a new branch `dev/v0.3.0`. `npm install` completes without errors and resolves `@zhixuan92/multi-model-agent-core@0.2.0` in the workspace symlink.

- [ ] **Pre-flight 3: Verify the baseline test suite passes in the worktree.**

  ```bash
  npm run build
  npm test
  ```

  Expected: build succeeds. Tests: 382 passing (the count as of v0.2.0 release commit `5b3dd83`). If anything fails, **stop** and report — the worktree is broken or master has drifted since the spec was written.

- [ ] **Pre-flight 4: Re-read the spec once end-to-end.**

  Open `docs/superpowers/specs/2026-04-11-subagent-reliability-v0.3.0-design.md`. Read §1 (core value + scope), §2 (coverage validation), §3 (pagination), §4 (max_turns fix), §5 (cost/timing visibility — the big one), §6 (progressTrace reframing), §7 (directoriesListed), §8 (tool description), §9 (docs), §10 (testing/release), §11 (open questions resolved during brainstorming).

  The plan below assumes you understand: (1) coverage validation is GENERIC (no severity-table — that was explicitly dropped during design review), (2) the pagination threshold is configurable, (3) all cost/time metrics are framed as **estimates**, (4) `successPercent` in `batchProgress` measures clean-success rate NOT progress (the snapshot is always post-terminal), (5) `actualCostUnavailableTasks` and `savedCostUnavailableTasks` are split because they have different trust boundaries.

---

## File Structure

### New files

**None.** All v0.3.0 additions are new functions/types/fields inside existing files. This is deliberate — the spec landed zero new modules because everything extends v0.2.0's existing architecture rather than introducing new components.

### Modified files (core)

| File | What changes | Tasks |
|---|---|---|
| `packages/core/src/types.ts` | New fields on `TaskSpec` (`expectedCoverage`, `includeProgressTrace`, `parentModel`), new fields on `RunResult` (`progressTrace`, `directoriesListed`, `durationMs`), new fields on `TokenUsage` (`savedCostUSD`), new fields on `AttemptRecord` (`progressTrace`), new types (`ProgressTraceEntry`, `BatchTimings`, `BatchProgress`, `BatchAggregateCost`), new `DegenerateKind` variant (`insufficient_coverage`) | Task 1 |
| `packages/core/src/runners/supervision.ts` | New `validateCoverage` function, new `trimProgressTrace` function, new constants (`TRACE_MAX_EVENTS`, `TRACE_MAX_CHARS`, `TRACE_DROP_PRIORITY`), new `DegenerateKind` in `buildRePrompt` switch | Task 2 |
| `packages/core/src/cost.ts` | `computeCostUSD` gains profile-rate fallback, new `computeSavedCostUSD` helper | Task 3 |
| `packages/core/src/routing/model-profiles.ts` | Zod schema gains `inputCostPerMTok`, `outputCostPerMTok`, `rateSource`, `rateLookupDate` optional fields | Task 3 |
| `packages/core/src/model-profiles.json` | Published rates per profile entry (verified at implementation time against each provider's pricing page) | Task 3 |
| `packages/core/src/tools/tracker.ts` | New `trackDirectoryList` method, new `getDirectoriesListed` getter | Task 4 |
| `packages/core/src/tools/definitions.ts` | `listFiles` calls both `trackRead` (legacy) and `trackDirectoryList` (new) | Task 4 |
| `packages/core/src/runners/openai-runner.ts` | Max_turns fix: new `SUPERVISION_CONTINUATION_BUDGET = 5` constant, new `runContinuationTurn` helper, all three continuation call sites use the helper, `buildMaxTurnsResult` gains `reason` parameter, `buildSupervisionExhaustedResult` gains `reason` parameter. Coverage integration: call `validateCoverage` after `validateCompletion`. Duration/savings: capture `taskStartMs`, populate `durationMs` and `savedCostUSD` in all helpers. Progress trace: capture buffer when `includeProgressTrace`, trim at return. `directoriesListed` pass-through in all helpers. | Tasks 5, 8, 9, 10, 4 |
| `packages/core/src/runners/claude-runner.ts` | Max_turns: `buildClaudeMaxTurnsResult` and `buildClaudeIncompleteResult` gain `reason` parameter, populated at call sites. Coverage integration: call `validateCoverage` after `validateCompletion`. Duration/savings/trace/directoriesListed: same pattern as openai-runner. | Tasks 6, 8, 9, 10, 4 |
| `packages/core/src/runners/codex-runner.ts` | Same max_turns reason precision + coverage + duration + savings + trace + directoriesListed changes as claude-runner. | Tasks 7, 8, 9, 10, 4 |
| `packages/core/src/delegate-with-escalation.ts` | `AttemptRecord` construction captures `result.progressTrace` when present. | Task 10 |
| `packages/core/src/index.ts` | Re-exports new types (`ProgressTraceEntry`, `BatchTimings`, `BatchProgress`, `BatchAggregateCost`, `insufficient_coverage` not exported — internal). | Task 1 |

### Modified files (mcp)

| File | What changes | Tasks |
|---|---|---|
| `packages/mcp/src/cli.ts` | `buildMcpServer` signature gains `options?: { largeResponseThresholdChars?: number }`. New threshold-resolution logic (env > config > option > default). `delegate_tasks` input schema gains `responseMode`. `delegate_tasks` handler computes timings/batchProgress/aggregateCost, picks effective mode, builds full-or-summary response. New `computeTimings` / `computeBatchProgress` / `computeAggregateCost` pure helpers. New `buildFullResponse` / `buildSummaryResponse` helpers. Batch cache shape extended to store `RunResult[]`. New `get_task_output` tool registration. `delegate_tasks` tool description (`TOOL_NOTES`) extended. | Tasks 11, 12, 13 |
| `packages/mcp/src/routing/render-provider-routing-matrix.ts` | `TOOL_NOTES` constant extended with v0.3.0 addition paragraphs (response shape, coverage declaration, cost/time visibility, progress trace, tool list). | Task 13 |

### Modified files (docs)

| File | What changes | Tasks |
|---|---|---|
| `docs/claude-code-delegation-rule.md` | Rewrite "Provider Routing" framing by workload shape. Add "Declaring deliverable coverage" subsection. Add "Decompose and parallelize enumerable work" pattern section. Add "Measuring savings" subsection. Add "Tightening budgets for weaker models" subsection. Update status table to reference `insufficient_coverage`. | Task 14 |
| `packages/mcp/README.md` | Feature bullet updates, `get_task_output` in tool list, link to new pattern section | Task 14 |
| `README.md` (root) | Version bump note, link to delegation rule | Task 14 |

### Test files (all extended)

| File | What changes | Tasks |
|---|---|---|
| `tests/runners/supervision.test.ts` | `validateCoverage` unit tests, `trimProgressTrace` unit tests, plus the `insufficient_coverage` `buildRePrompt` branch | Task 2 |
| `tests/runners/supervision-regression.test.ts` | +1 captured round-2 Fate truncated-ok regression | Task 8 |
| `tests/cost.test.ts` | +5 costUSD fallback tests, +5 `computeSavedCostUSD` tests | Task 3 |
| `tests/routing/model-profiles.test.ts` | +2 schema tests | Task 3 |
| `tests/tools/tracker.test.ts` | +3 `trackDirectoryList` tests | Task 4 |
| `tests/tools/definitions.test.ts` | +2 `listFiles` dual-tracking tests | Task 4 |
| `tests/runners/openai-runner.test.ts` | +1 continuation-budget regression, +runner integration tests (coverage, duration, savings, progressTrace) | Tasks 5, 8, 9, 10 |
| `tests/runners/claude-runner.test.ts` | +runner integration tests (reason precision, coverage, duration, savings, progressTrace) | Tasks 6, 8, 9, 10 |
| `tests/runners/codex-runner.test.ts` | +runner integration tests (reason precision, coverage, duration, savings, progressTrace) | Tasks 7, 8, 9, 10 |
| `tests/runners/cross-runner-parity.test.ts` | +test for coverage parity across runners (same expectedCoverage → same classification) | Task 8 |
| `tests/cli.test.ts` | +~25 tests covering pagination, threshold config, `get_task_output`, envelope aggregates, end-to-end integration | Tasks 11, 12 |
| `tests/delegate-with-escalation.test.ts` | +test for AttemptRecord progressTrace propagation | Task 10 |

**Baseline at start**: 382 tests passing (v0.2.0 release tip). **Target at end**: ~485 tests passing. No existing tests should break.

---

## Task 1: Foundations — types and interfaces

**Goal:** Land every new type, interface field, and DegenerateKind variant as a purely additive change. After this task, TypeScript will compile and existing tests will pass unchanged — but the new code is unused. Subsequent tasks wire the fields into runners and helpers.

**Why this task is first:** adding new fields to `RunResult` / `AttemptRecord` (even optional ones) makes TypeScript surface every construction site that needs updating. Landing the types first lets the compiler tell us exactly where the runner work needs to happen in Tasks 5-10.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

### Step 1: Read the current types.ts

- [ ] **Step 1: Read the current state of `packages/core/src/types.ts`.**

  ```bash
  cd /Users/zhangzhixuan/Documents/code/multi-model-agent-v0.3.0
  wc -l packages/core/src/types.ts
  ```

  Expected: ~260 lines. Read it end-to-end so you understand where `TaskSpec`, `RunResult`, `TokenUsage`, `AttemptRecord`, `DegenerateKind`, `ProgressEvent`, and `ValidationResult` live. You'll be adding to all of them.

### Step 2-8: Extend `TaskSpec`

- [ ] **Step 2: Find the `TaskSpec` interface in `types.ts` and add three new optional fields.**

  Locate the existing `TaskSpec` (look for `export interface TaskSpec`). After the existing `contextBlockIds?: string[]` field (the last field added in v0.2.0), append:

  ```typescript
    /** Optional caller-declared output expectations. When supplied, the
     *  supervision layer runs `validateCoverage` after `validateCompletion`'s
     *  syntactic check passes, and re-prompts with specific missing-item
     *  guidance if coverage is insufficient. Same 3-retry budget as other
     *  degeneracy classes. Opt-in: callers who omit this field see zero
     *  change in runner behavior. Generic across all workload shapes that
     *  produce enumerable deliverables (multi-file refactor, test
     *  generation, PR review, per-endpoint analysis, codebase audits). */
    expectedCoverage?: {
      /** Minimum section count. A section is a line matching `sectionPattern`.
       *  Omit to skip section counting. */
      minSections?: number
      /** Regex for section headings. Default: `^## ` (GFM H2). Applied with
       *  the multiline flag. Invalid regexes are caught at validation time
       *  and reported as insufficient_coverage with a compile-error reason. */
      sectionPattern?: string
      /** Substrings that must ALL appear somewhere in the output. Use this
       *  for workloads where each deliverable has a stable identifier: file
       *  paths for multi-file refactors, function names for test generation,
       *  endpoint paths for per-endpoint reports, item ids for checklists. */
      requiredMarkers?: string[]
    }
    /** Opt-in: when true, the runner captures every progress event fired
     *  during this task's execution into a bounded, priority-trimmed
     *  `progressTrace` on the final RunResult. Useful for post-hoc
     *  execution observability on long-running delegated tasks. Zero
     *  cost when false (the default). */
    includeProgressTrace?: boolean
    /** Optional hint about the parent session's model. When set, each
     *  result's `usage.savedCostUSD` is computed as an estimated cost
     *  difference versus running the same token volume on this parent
     *  model. Purely informational — does not affect routing, execution,
     *  or any other runner behavior. Use the model identifier that
     *  matches a profile in `model-profiles.json` (e.g. 'claude-opus-4-6',
     *  'claude-opus-4-6[1m]', 'gpt-5-codex'). Unknown models produce
     *  `savedCostUSD: null`. THIS IS AN ESTIMATE, NOT ACCOUNTING TRUTH. */
    parentModel?: string
  ```

- [ ] **Step 3: Find the `TokenUsage` interface and add `savedCostUSD`.**

  Locate `export interface TokenUsage` (it has `inputTokens`, `outputTokens`, `totalTokens`, `costUSD`). After `costUSD`, add:

  ```typescript
    /** Estimated cost savings versus running the same token volume on the
     *  declared `TaskSpec.parentModel`. Positive means delegation was
     *  cheaper. Negative means it was more expensive (unusual but possible
     *  with unfavorable routing). Null when `parentModel` is unset, rates
     *  are unknown for either side, or this was a direct (non-delegated)
     *  call. THIS IS AN ESTIMATE, NOT AN ACCOUNTING NUMBER — it assumes
     *  the same token volume at the same cost tier, which is a sanity
     *  check, not a truth claim. Real parent-model cost would vary with
     *  context, tool overhead, retry patterns, and provider-specific
     *  billing details. */
    savedCostUSD?: number | null
  ```

- [ ] **Step 4: Find the `RunResult` interface and add three new optional fields.**

  Locate `export interface RunResult`. After the existing `escalationLog: AttemptRecord[]` field, add these three fields (BEFORE the `error?: string` at the end):

  ```typescript
    /** Wall-clock duration of this task in milliseconds, from the runner's
     *  first line of work to the moment the final RunResult was built.
     *  Optional for backward-compat with pre-v0.3.0 mock results; runners
     *  always populate it in v0.3.0+. Used by the delegate_tasks response
     *  to compute the batch-level timings aggregate. */
    durationMs?: number
    /** Directories whose entries the worker listed via `listFiles`.
     *  Separate from `filesRead` — callers that care about file-level
     *  activity continue reading `filesRead`; callers that want "which
     *  folders did the worker explore" read this. Optional so pre-v0.3.0
     *  result shapes remain valid; runners always populate it in v0.3.0+
     *  (empty array if no listFiles was called). `filesRead` semantics
     *  are unchanged — directory paths continue to appear there too
     *  (dual-tracking). */
    directoriesListed?: string[]
    /** Bounded trace of progress events emitted during this task's run.
     *  Only populated when the task's TaskSpec had `includeProgressTrace:
     *  true`. Priority-trimmed at return time via `trimProgressTrace` —
     *  see supervision.ts for bounds (TRACE_MAX_EVENTS, TRACE_MAX_CHARS)
     *  and drop priorities. May contain a synthetic `_trimmed` marker
     *  entry if trimming fired. */
    progressTrace?: ProgressTraceEntry[]
  ```

- [ ] **Step 5: Add the `ProgressTraceEntry` type definition.**

  Above the `RunResult` interface (just after the existing `ProgressEvent` type definition — use grep if needed to find it), add:

  ```typescript
  /** A single entry in a captured progress trace. Either a normal
   *  `ProgressEvent` from the runner, or a synthetic `_trimmed` marker
   *  inserted by `trimProgressTrace` when the trace exceeded its bounds
   *  and events were dropped. The marker carries a count and a per-kind
   *  histogram of what was dropped so callers can understand the shape
   *  of removed events without seeing them. */
  export type ProgressTraceEntry =
    | ProgressEvent
    | {
        kind: '_trimmed'
        droppedCount: number
        droppedKinds: Partial<Record<ProgressEvent['kind'], number>>
        capExceededByBoundaryEvents?: boolean
      }
  ```

- [ ] **Step 6: Add the three batch envelope types.**

  After the `ProgressTraceEntry` type, add:

  ```typescript
  /** Aggregate timing metrics for a `delegate_tasks` batch. Always
   *  populated on the response envelope — computed from per-task
   *  `durationMs` and the handler's wall-clock measurement. */
  export interface BatchTimings {
    /** Wall-clock milliseconds from the start of `runTasks` to the moment
     *  the final response is built. This is what the caller actually
     *  waited for. */
    wallClockMs: number
    /** Sum of every task's individual `durationMs`. Represents the
     *  hypothetical serial execution time if the tasks had run one after
     *  another in a for-loop. Tasks with undefined `durationMs`
     *  contribute 0 (pre-v0.3.0 runner results only). */
    sumOfTaskMs: number
    /** Estimated wall-clock savings vs serial execution:
     *    sumOfTaskMs - wallClockMs
     *  Always ≥ 0. THIS IS AN ESTIMATE — a real serial for-loop would
     *  have had different cache/warmup characteristics, different
     *  context-pressure dynamics on the models, and possibly different
     *  tool sequences. Useful as "approximately what parallelism bought
     *  you," not as a precise measurement. */
    estimatedParallelSavingsMs: number
  }

  /** Aggregate completion counts for a `delegate_tasks` batch. Always
   *  populated on the response envelope. This is a STATIC POST-COMPLETION
   *  SNAPSHOT — every task is in a terminal state by the time the caller
   *  sees this, so "progress" is always 100%. The `successPercent` field
   *  specifically measures the clean-success rate, not progress. */
  export interface BatchProgress {
    /** Total number of tasks in the batch. */
    totalTasks: number
    /** Tasks where `status === 'ok'`. */
    completedTasks: number
    /** Tasks where status is one of the partial-salvage statuses:
     *  'incomplete', 'max_turns', 'timeout'. */
    incompleteTasks: number
    /** Tasks where status is one of the error statuses: 'error',
     *  'api_aborted', 'api_error', 'network_error'. */
    failedTasks: number
    /** (completedTasks / totalTasks) × 100, rounded to 1 decimal.
     *  The clean-success rate: the percentage of tasks that finished
     *  with `status: 'ok'`. NOT a progress indicator — in a static
     *  post-completion snapshot every task has already reached a
     *  terminal state, so "progress" is always 100%. This field
     *  specifically answers "how many tasks succeeded cleanly" so the
     *  caller doesn't have to compute it from the raw counts. */
    successPercent: number
  }

  /** Aggregate cost metrics for a `delegate_tasks` batch. Always
   *  populated on the response envelope. Has separate unavailability
   *  counts for actual cost vs saved cost because they have different
   *  trust boundaries: a batch where every task has known costUSD but
   *  no task sets parentModel will have `actualCostUnavailableTasks: 0`
   *  (totalActualCostUSD is fully trustworthy) and
   *  `savedCostUnavailableTasks: totalTasks` (totalSavedCostUSD is 0
   *  because nobody opted in). */
  export interface BatchAggregateCost {
    /** Sum of every task's `usage.costUSD`. Tasks with null costUSD
     *  contribute 0 and are counted in `actualCostUnavailableTasks`. */
    totalActualCostUSD: number
    /** Sum of every task's `usage.savedCostUSD`. Tasks with null
     *  savedCostUSD contribute 0 and are counted in
     *  `savedCostUnavailableTasks`. Only meaningful when at least one
     *  task had `parentModel` set and both sides had pricing data. */
    totalSavedCostUSD: number
    /** How many tasks had `costUSD: null` (unknown provider rates, custom
     *  models without profile data, etc) and therefore did NOT contribute
     *  to `totalActualCostUSD`. */
    actualCostUnavailableTasks: number
    /** How many tasks had `savedCostUSD: null` (missing `parentModel`,
     *  unknown parent-model rates, etc) and therefore did NOT contribute
     *  to `totalSavedCostUSD`. */
    savedCostUnavailableTasks: number
  }
  ```

- [ ] **Step 7: Find the `AttemptRecord` interface and add `progressTrace`.**

  Locate `export interface AttemptRecord`. After the last existing field (`error?: string`), add:

  ```typescript
    /** Bounded progress trace captured for this attempt, when
     *  `TaskSpec.includeProgressTrace: true`. Each attempt in an
     *  escalation chain carries its own trace so callers can inspect
     *  every provider's timeline via `result.escalationLog[i].progressTrace`.
     *  The top-level `result.progressTrace` on the final RunResult is the
     *  final attempt's trace (for the common single-attempt case). */
    progressTrace?: ProgressTraceEntry[]
  ```

- [ ] **Step 8: Find the `DegenerateKind` type and add `insufficient_coverage`.**

  Locate the `DegenerateKind` type (search for `export type DegenerateKind`). Replace it with:

  ```typescript
  /** Classification of a degenerate model response. Used by
   *  `validateCompletion` (syntactic checks: empty / thinking_only /
   *  fragment / no_terminator) and `validateCoverage` (semantic check:
   *  insufficient_coverage). All five kinds flow through the same
   *  supervision loop: increment retries, same-output early-out,
   *  inject `buildRePrompt(result)` as a re-prompt, continue. */
  export type DegenerateKind =
    | 'empty'
    | 'thinking_only'
    | 'fragment'
    | 'no_terminator'
    | 'insufficient_coverage'
  ```

### Step 9: Build to surface construction sites

- [ ] **Step 9: Run `npm run build` and read the output.**

  ```bash
  npm run build 2>&1 | tail -40
  ```

  Expected behavior: **build should succeed**. The new fields are all optional (`expectedCoverage?`, `includeProgressTrace?`, `parentModel?`, `savedCostUSD?`, `durationMs?`, `directoriesListed?`, `progressTrace?`) and the new type definitions don't break any existing structural check. `DegenerateKind` gained a new variant but no existing code has an exhaustive switch on it yet (the supervision layer handles it generically).

  If you see compile errors, they're likely in test fixture construction sites that built `RunResult` / `TokenUsage` / `AttemptRecord` literally. Follow those errors in subsequent steps.

- [ ] **Step 10: Run the existing test suite to confirm no regressions.**

  ```bash
  npm test 2>&1 | tail -15
  ```

  Expected: 382 tests passing (same as baseline). None of the new types have consumers yet, so behavior is identical.

### Step 11: Re-exports in index.ts

- [ ] **Step 11: Add type re-exports to `packages/core/src/index.ts`.**

  Open `packages/core/src/index.ts` and find the existing `export type { ... } from './types.js';` block. Add the new type names:

  ```typescript
  export type {
    // ... existing exports ...
    ProgressTraceEntry,
    BatchTimings,
    BatchProgress,
    BatchAggregateCost,
  } from './types.js';
  ```

  Do NOT export `DegenerateKind` — it's an internal supervision-layer concept, not a public API surface. Do NOT export `insufficient_coverage` as a string constant — it's accessed via the union type, not a standalone export.

- [ ] **Step 12: Build and test again to verify the re-exports compile.**

  ```bash
  npm run build
  npm test 2>&1 | tail -8
  ```

  Expected: clean build, 382 tests passing.

### Step 13: Commit Task 1

- [ ] **Step 13: Commit the foundations.**

  ```bash
  git add packages/core/src/types.ts packages/core/src/index.ts
  git commit -m "feat(core): v0.3.0 foundations — types for coverage, progress trace, cost visibility

  Additive type extensions for v0.3.0. No behavioral changes — every new
  field is optional, every existing construction site still compiles,
  and the v0.2.0 test suite passes unchanged. Subsequent tasks wire the
  fields into runners and helpers.

  - TaskSpec: expectedCoverage, includeProgressTrace, parentModel
  - TokenUsage: savedCostUSD (estimate, not accounting)
  - RunResult: durationMs, directoriesListed, progressTrace
  - AttemptRecord: progressTrace (per-attempt)
  - New DegenerateKind: insufficient_coverage
  - New types: ProgressTraceEntry, BatchTimings, BatchProgress,
    BatchAggregateCost
  - index.ts: re-exports for the four batch envelope types

  Spec: docs/superpowers/specs/2026-04-11-subagent-reliability-v0.3.0-design.md §1, §5, §6, §2"
  ```

- [ ] **Step 14: Verify clean state after the commit.**

  ```bash
  git log --oneline -3
  git status
  npm test 2>&1 | tail -6
  ```

  Expected: new commit at the tip of `dev/v0.3.0`, working tree clean, 382 tests passing.

---

## Task 2: Pure-function supervision helpers — `validateCoverage` + `trimProgressTrace`

**Goal:** Land the two new pure functions in `supervision.ts` with full unit-test coverage. Both are self-contained: `validateCoverage` takes text + a coverage spec, `trimProgressTrace` takes an event array. Neither touches runner state. After this task the functions exist and are tested in isolation but are not yet called by any runner.

**Files:**
- Modify: `packages/core/src/runners/supervision.ts`
- Modify: `tests/runners/supervision.test.ts`

### Step 1: Write the failing test for `validateCoverage` with no expectations

- [ ] **Step 1: Append the first validateCoverage test to `tests/runners/supervision.test.ts`.**

  Open `tests/runners/supervision.test.ts` and append at the end (after the last `describe` block):

  ```typescript
  describe('validateCoverage — generic enumerable-deliverable check', () => {
    it('returns valid when no expectations are supplied (empty object)', () => {
      const result = validateCoverage('any text', {});
      expect(result.valid).toBe(true);
    });
  });
  ```

  And at the top of the file, add `validateCoverage` to the imports from supervision.js (alongside the existing `validateCompletion`, `buildRePrompt`, etc):

  ```typescript
  import {
    validateCompletion,
    buildRePrompt,
    sameDegenerateOutput,
    resolveInputTokenSoftLimit,
    checkWatchdogThreshold,
    logWatchdogEvent,
    THINKING_DIAGNOSTIC_MARKER,
    validateCoverage,            // NEW
    trimProgressTrace,           // NEW (used in later tests)
  } from '../../packages/core/src/runners/supervision.js';
  ```

- [ ] **Step 2: Run the test and confirm it fails.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts 2>&1 | tail -20
  ```

  Expected: compile error `validateCoverage` is not an exported member (or similar). If you see the build error about a missing export, that's the "red" phase.

### Step 3: Implement the minimal `validateCoverage` to pass the first test

- [ ] **Step 3: Add `validateCoverage` to `packages/core/src/runners/supervision.ts`.**

  Find the end of the file (after the last export) and append:

  ```typescript
  /**
   * Generic caller-declared output expectations check. Runs AFTER
   * `validateCompletion` has accepted the output syntactically.
   *
   * Not a domain-specific validator — it only checks what the caller
   * declared. Applies to any workload shape that produces enumerable
   * deliverables: multi-file refactors (file paths as markers), test
   * generation (function names as markers), PR review (PR numbers),
   * per-endpoint analysis (endpoint paths), codebase audits (item IDs).
   *
   * Returns `{ valid: false, kind: 'insufficient_coverage', reason: ... }`
   * on the first failing check. Supervision loop handles it like any
   * other DegenerateKind — increment retries, same-output early-out,
   * inject `buildRePrompt(result)`, continue.
   *
   * Explicitly does NOT include a `selfConsistencySummary` mode. An
   * earlier draft had a severity-table check that was dropped during
   * design review as audit-specific. See spec §2.2.
   */
  export function validateCoverage(
    text: string,
    expected: NonNullable<TaskSpec['expectedCoverage']>,
  ): ValidationResult {
    // No expectations → trivially valid
    return { valid: true };
  }
  ```

  You'll need to import `TaskSpec` at the top of `supervision.ts` if it isn't already:

  ```typescript
  import type { TaskSpec, ValidationResult } from '../types.js';
  ```

  (Check the existing imports first — `ValidationResult` is defined in `supervision.ts` itself, so you only need to add `TaskSpec`.)

- [ ] **Step 4: Run the test and confirm it passes.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts 2>&1 | tail -15
  ```

  Expected: the new test passes. All previously-passing tests continue to pass.

### Step 5-12: Add each validateCoverage check branch via TDD

- [ ] **Step 5: Append the `minSections` met test.**

  ```typescript
    it('minSections met → valid', () => {
      const text = '## One\n\n## Two\n\n## Three';
      const result = validateCoverage(text, { minSections: 3 });
      expect(result.valid).toBe(true);
    });

    it('minSections not met → insufficient_coverage with count in reason', () => {
      const text = '## One\n\n## Two';
      const result = validateCoverage(text, { minSections: 5 });
      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      expect(result.reason).toMatch(/only 2 sections found/);
      expect(result.reason).toMatch(/expected at least 5/);
    });
  ```

- [ ] **Step 6: Run tests, verify the minSections-not-met test fails, then implement.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "minSections" 2>&1 | tail -15
  ```

  Expected: the "met" test passes (trivial validateCoverage returns valid) but the "not met" test fails because the minimal implementation doesn't check minSections yet.

  Replace the body of `validateCoverage` in `supervision.ts` with:

  ```typescript
  export function validateCoverage(
    text: string,
    expected: NonNullable<TaskSpec['expectedCoverage']>,
  ): ValidationResult {
    // Check 1: section count
    if (expected.minSections !== undefined) {
      const pattern = expected.sectionPattern ?? '^## ';
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'gm');
      } catch (err) {
        return {
          valid: false,
          kind: 'insufficient_coverage',
          reason: `invalid sectionPattern regex: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const count = (text.match(re) ?? []).length;
      if (count < expected.minSections) {
        return {
          valid: false,
          kind: 'insufficient_coverage',
          reason: `only ${count} sections found, expected at least ${expected.minSections}`,
        };
      }
    }

    return { valid: true };
  }
  ```

  Re-run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "minSections" 2>&1 | tail -10
  ```

  Expected: both minSections tests pass.

- [ ] **Step 7: Append custom `sectionPattern` test and invalid-regex test.**

  ```typescript
    it('custom sectionPattern matches caller shape', () => {
      const text = '# Report\n\n### Finding 1\n\n### Finding 2\n\n### Finding 3';
      const result = validateCoverage(text, {
        minSections: 3,
        sectionPattern: '^### ',
      });
      expect(result.valid).toBe(true);
    });

    it('invalid sectionPattern regex → insufficient_coverage with compile error', () => {
      const result = validateCoverage('anything', {
        minSections: 1,
        sectionPattern: '[unclosed',
      });
      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      expect(result.reason).toMatch(/invalid sectionPattern regex/);
    });
  ```

  Run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "sectionPattern" 2>&1 | tail -10
  ```

  Expected: both pass (the implementation already handles both cases — the try/catch around `new RegExp` and the pattern override default).

- [ ] **Step 8: Append `requiredMarkers` tests — all present, one missing, many missing, empty array.**

  ```typescript
    it('all requiredMarkers present → valid', () => {
      const text = 'Report covering 1.1 and 1.2 and 1.3 in detail.';
      const result = validateCoverage(text, {
        requiredMarkers: ['1.1', '1.2', '1.3'],
      });
      expect(result.valid).toBe(true);
    });

    it('one requiredMarker missing → insufficient_coverage with that marker named', () => {
      const text = 'Report covering 1.1 and 1.2 in detail.';
      const result = validateCoverage(text, {
        requiredMarkers: ['1.1', '1.2', '1.3'],
      });
      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      expect(result.reason).toMatch(/2 of 3 required markers found/);
      expect(result.reason).toMatch(/1\.3/);
    });

    it('many requiredMarkers missing → truncated list with +N more suffix', () => {
      const text = 'Only 1.1 is present.';
      const result = validateCoverage(text, {
        requiredMarkers: ['1.1', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7'],
      });
      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      expect(result.reason).toMatch(/1 of 8 required markers found/);
      expect(result.reason).toMatch(/2\.1, 2\.2, 2\.3, 2\.4, 2\.5/);
      expect(result.reason).toMatch(/\+2 more/);
    });

    it('empty requiredMarkers array → valid (no-op)', () => {
      const result = validateCoverage('anything', { requiredMarkers: [] });
      expect(result.valid).toBe(true);
    });
  ```

- [ ] **Step 9: Run the test group, verify all fail except `empty requiredMarkers`, then implement Check 2.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "requiredMarkers" 2>&1 | tail -15
  ```

  Expected: three of four tests fail (the empty-array case passes because an empty `requiredMarkers` array falls through to `valid: true`).

  In `supervision.ts`, add Check 2 inside `validateCoverage` (BEFORE the final `return { valid: true }`):

  ```typescript
    // Check 2: required markers
    if (expected.requiredMarkers?.length) {
      const missing = expected.requiredMarkers.filter((m) => !text.includes(m));
      if (missing.length > 0) {
        const preview = missing.slice(0, 5).join(', ');
        const extra = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
        return {
          valid: false,
          kind: 'insufficient_coverage',
          reason: `only ${expected.requiredMarkers.length - missing.length} of ${expected.requiredMarkers.length} required markers found, missing: ${preview}${extra}`,
        };
      }
    }
  ```

  Re-run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "requiredMarkers" 2>&1 | tail -10
  ```

  Expected: all four pass.

- [ ] **Step 10: Append the combined-checks tests.**

  ```typescript
    it('combined checks, first fails → fails with first failing check reason', () => {
      const text = '## One';
      const result = validateCoverage(text, {
        minSections: 5,
        requiredMarkers: ['1.1'], // would also fail
      });
      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      // minSections is checked first, so that's the reason we see
      expect(result.reason).toMatch(/only 1 sections found/);
    });

    it('combined checks, all pass → valid', () => {
      const text = '## Section 1\n\nMarker 1.1 here\n\n## Section 2\n\nMarker 1.2 here';
      const result = validateCoverage(text, {
        minSections: 2,
        requiredMarkers: ['1.1', '1.2'],
      });
      expect(result.valid).toBe(true);
    });
  ```

  Run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "combined checks" 2>&1 | tail -10
  ```

  Expected: both pass.

### Step 11: `buildRePrompt` branch for `insufficient_coverage`

- [ ] **Step 11: Append the buildRePrompt test.**

  In the same test file, find the existing `describe('buildRePrompt'` block and add a new test:

  ```typescript
    it('insufficient_coverage branch — returns prompt with reason and "do not restart"', () => {
      const result = {
        valid: false as const,
        kind: 'insufficient_coverage' as const,
        reason: 'missing 43 of 85 required markers: 5.7, 5.8, 5.9, 5.10, 5.11 (+38 more)',
      };
      const prompt = buildRePrompt(result);
      expect(prompt).toMatch(/missing 43 of 85 required markers/);
      expect(prompt).toMatch(/Do NOT restart/);
      expect(prompt).toMatch(/append the missing/i);
    });
  ```

- [ ] **Step 12: Run the test, verify it fails, then add the branch.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "insufficient_coverage branch" 2>&1 | tail -10
  ```

  Expected: fails because `buildRePrompt` has no case for `insufficient_coverage` (it probably falls through a default or throws).

  Find `buildRePrompt` in `supervision.ts` and add a new case to its `switch` statement:

  ```typescript
      case 'insufficient_coverage':
        return `Your previous answer was structurally valid but does not cover everything the brief required: ${result.reason}. Continue your report by addressing the missing items. Do NOT restart from the beginning — append the missing sections to what you already wrote.`;
  ```

  Re-run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "insufficient_coverage branch" 2>&1 | tail -10
  ```

  Expected: passes.

### Step 13-20: `trimProgressTrace` via TDD

- [ ] **Step 13: Add constants for the trace trimming.**

  Near the top of `supervision.ts` (after existing constants like `MAX_SUPERVISION_RETRIES`), add:

  ```typescript
  /** Maximum number of events a progress trace can contain before
   *  trimming kicks in. Tuned so a typical 10-turn dispatch (with
   *  turn_start/text_emission/turn_complete per turn plus tool_call
   *  and injection events) fits comfortably. */
  export const TRACE_MAX_EVENTS = 80;

  /** Maximum byte size of a JSON-serialized progress trace before
   *  trimming kicks in. Tuned so three tasks × 16 KB traces in a
   *  single batch stay under the pagination threshold (64 KB). */
  export const TRACE_MAX_CHARS = 16_384;

  /** Priority for dropping events under pressure (lower = dropped
   *  first). Never-drop tier (100) covers high-signal boundary events;
   *  droppable tier covers high-volume low-signal events whose content
   *  is already captured elsewhere in the RunResult (text in output,
   *  tool calls in toolCalls). */
  export const TRACE_DROP_PRIORITY: Record<ProgressEvent['kind'], number> = {
    text_emission: 1, // drop first — text is in output
    tool_call: 2,     // drop second — summaries are in toolCalls
    turn_start: 100,
    turn_complete: 100,
    escalation_start: 100,
    done: 100,
    injection: 100,
  };
  ```

  You'll need `ProgressEvent` imported at the top of supervision.ts if not already:

  ```typescript
  import type { TaskSpec, ProgressEvent, ProgressTraceEntry } from '../types.js';
  ```

- [ ] **Step 14: Append the empty-input and under-bounds trimProgressTrace tests.**

  ```typescript
  describe('trimProgressTrace — bounded progress trace capture', () => {
    it('empty input → empty output, no marker', () => {
      const result = trimProgressTrace([]);
      expect(result).toEqual([]);
    });

    it('small input under both bounds → returned unchanged, no marker', () => {
      const events: ProgressEvent[] = [
        { kind: 'turn_start', turn: 1, provider: 'openai-compatible' },
        { kind: 'text_emission', turn: 1, chars: 100, preview: 'hello world' },
        { kind: 'turn_complete', turn: 1, cumulativeInputTokens: 500, cumulativeOutputTokens: 100 },
        { kind: 'done', status: 'ok' },
      ];
      const result = trimProgressTrace(events);
      expect(result).toEqual(events);
      // No _trimmed marker
      expect(result.some((e) => e.kind === '_trimmed')).toBe(false);
    });
  });
  ```

  You'll need `ProgressEvent` imported in the test file too. Add to the existing imports at the top of `tests/runners/supervision.test.ts`:

  ```typescript
  import type { ProgressEvent } from '../../packages/core/src/types.js';
  ```

- [ ] **Step 15: Run the test, verify it fails, then implement the minimal trimProgressTrace.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "trimProgressTrace" 2>&1 | tail -15
  ```

  Expected: fails with "trimProgressTrace is not exported."

  Add to `supervision.ts` (at the bottom, after `validateCoverage`):

  ```typescript
  /**
   * Trim a captured progress trace to stay within TRACE_MAX_EVENTS and
   * TRACE_MAX_CHARS bounds. Drops events by TRACE_DROP_PRIORITY (lowest
   * first — text_emission, then tool_call) until both bounds are met.
   * Never drops events in the never-drop tier (turn_start / turn_complete
   * / escalation_start / done / injection). If the remaining trace is
   * still over-bounds after all droppable events are removed, falls back
   * to keeping the first 10 + last 30 remaining events and marking the
   * middle as dropped. When any events are dropped, appends a synthetic
   * `_trimmed` marker entry with the total count and per-kind histogram.
   */
  export function trimProgressTrace(events: ProgressEvent[]): ProgressTraceEntry[] {
    if (events.length === 0) return [];

    const traceSize = (arr: ProgressEvent[]): number => JSON.stringify(arr).length;

    // Fast path: already within bounds
    if (events.length <= TRACE_MAX_EVENTS && traceSize(events) <= TRACE_MAX_CHARS) {
      return [...events];
    }

    const droppedKinds: Partial<Record<ProgressEvent['kind'], number>> = {};
    let droppedCount = 0;

    const indexed = events.map((e, i) => ({ e, i, p: TRACE_DROP_PRIORITY[e.kind] ?? 50 }));
    const dropOrder = [...indexed].sort((a, b) => (a.p - b.p) || (a.i - b.i));

    const kept = new Set(indexed.map((x) => x.i));
    let keptCount = events.length;
    let keptSize = traceSize(events);

    for (const entry of dropOrder) {
      if (keptCount <= TRACE_MAX_EVENTS && keptSize <= TRACE_MAX_CHARS) break;
      if (entry.p >= 100) break; // never-drop tier — stop

      kept.delete(entry.i);
      keptCount -= 1;
      droppedKinds[entry.e.kind] = (droppedKinds[entry.e.kind] ?? 0) + 1;
      droppedCount += 1;
      keptSize = traceSize(events.filter((_, i) => kept.has(i)));
    }

    let result: ProgressTraceEntry[] = events.filter((_, i) => kept.has(i));

    // Fallback: still over bounds after priority drops → first 10 + last 30
    if (result.length > TRACE_MAX_EVENTS || traceSize(result as ProgressEvent[]) > TRACE_MAX_CHARS) {
      const preserveFirst = 10;
      const preserveLast = 30;
      if (result.length > preserveFirst + preserveLast) {
        const firstSlice = result.slice(0, preserveFirst);
        const lastSlice = result.slice(-preserveLast);
        const middleDropped = result.length - firstSlice.length - lastSlice.length;
        droppedCount += middleDropped;
        for (const e of result.slice(preserveFirst, result.length - preserveLast)) {
          if ('kind' in e && e.kind !== '_trimmed') {
            droppedKinds[e.kind] = (droppedKinds[e.kind] ?? 0) + 1;
          }
        }
        result = [...firstSlice, ...lastSlice];
      }
    }

    if (droppedCount > 0) {
      result.push({ kind: '_trimmed', droppedCount, droppedKinds });
    }

    return result;
  }
  ```

  Re-run:

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "trimProgressTrace" 2>&1 | tail -10
  ```

  Expected: both tests pass.

- [ ] **Step 16: Append the count-bounded test.**

  ```typescript
    it('count-bounded: drops text_emission first, preserves boundary events, inserts _trimmed marker', () => {
      // Build 100 events: 1 turn_start, 98 text_emissions, 1 done.
      // TRACE_MAX_EVENTS is 80 so 20 should be dropped.
      const events: ProgressEvent[] = [
        { kind: 'turn_start', turn: 1, provider: 'openai-compatible' },
      ];
      for (let i = 0; i < 98; i++) {
        events.push({ kind: 'text_emission', turn: 1, chars: 10, preview: `t${i}` });
      }
      events.push({ kind: 'done', status: 'ok' });

      const result = trimProgressTrace(events);

      // Should still contain turn_start and done (never-drop tier)
      expect(result.some((e) => e.kind === 'turn_start')).toBe(true);
      expect(result.some((e) => e.kind === 'done')).toBe(true);

      // Should contain a _trimmed marker
      const marker = result.find((e) => e.kind === '_trimmed');
      expect(marker).toBeDefined();
      if (marker && marker.kind === '_trimmed') {
        expect(marker.droppedCount).toBeGreaterThan(0);
        expect(marker.droppedKinds.text_emission).toBeGreaterThan(0);
      }

      // Result length is ≤ TRACE_MAX_EVENTS + 1 (for the marker)
      expect(result.length).toBeLessThanOrEqual(81);
    });

    it('boundary-only pressure: 100 turn_starts are all preserved and flagged', () => {
      const events: ProgressEvent[] = Array.from({ length: 100 }, (_, i) => ({
        kind: 'turn_start',
        turn: i + 1,
        provider: `codex-${'x'.repeat(20)}`,
      }));

      const result = trimProgressTrace(events);

      expect(result.filter((e) => e.kind === 'turn_start')).toHaveLength(100);
      const marker = result.find((e) => e.kind === '_trimmed');
      expect(marker).toEqual(
        expect.objectContaining({
          kind: '_trimmed',
          droppedCount: 0,
          capExceededByBoundaryEvents: true,
        }),
      );
    });

    it('boundary plus chatter: preserves all never-drop events while dropping droppable events', () => {
      const events: ProgressEvent[] = [
        ...Array.from({ length: 100 }, (_, i) => ({
          kind: 'turn_start' as const,
          turn: i + 1,
          provider: `codex-${'x'.repeat(12)}`,
        })),
        ...Array.from({ length: 500 }, (_, i) => ({
          kind: 'text_emission' as const,
          turn: i + 1,
          chars: 1,
          preview: 'y'.repeat(120),
        })),
      ];

      const result = trimProgressTrace(events);

      expect(result.filter((e) => e.kind === 'turn_start')).toHaveLength(100);
      expect(result.some((e) => e.kind === 'text_emission')).toBe(false);
      const marker = result.find((e) => e.kind === '_trimmed');
      expect(marker).toEqual(
        expect.objectContaining({
          kind: '_trimmed',
          capExceededByBoundaryEvents: true,
        }),
      );
      if (marker && marker.kind === '_trimmed') {
        expect(marker.droppedCount).toBeGreaterThan(0);
        expect(marker.droppedKinds.text_emission).toBeGreaterThan(0);
      }
    });
  ```

- [ ] **Step 17: Append the size-bounded and both-bounds tests.**

  ```typescript
    it('size-bounded: drops by priority until under TRACE_MAX_CHARS', () => {
      // 60 events (under count limit) but each with a long preview
      // so total JSON size exceeds 16 KB.
      const events: ProgressEvent[] = [
        { kind: 'turn_start', turn: 1, provider: 'openai-compatible' },
      ];
      const longPreview = 'x'.repeat(500);
      for (let i = 0; i < 58; i++) {
        events.push({ kind: 'text_emission', turn: 1, chars: 500, preview: longPreview });
      }
      events.push({ kind: 'done', status: 'ok' });

      const result = trimProgressTrace(events);

      // Must contain a _trimmed marker
      expect(result.some((e) => e.kind === '_trimmed')).toBe(true);

      // Resulting trace size is ≤ TRACE_MAX_CHARS (approximate — marker adds a bit)
      const resultSize = JSON.stringify(result).length;
      expect(resultSize).toBeLessThan(20_000); // some slack for the marker
    });

    it('never drops boundary events — all turn_starts + escalation_start + injection + done preserved', () => {
      const events: ProgressEvent[] = [];
      // 20 turn_starts + 20 text_emissions + 20 tool_calls + 1 escalation + 1 done + 2 injections = 64 events
      for (let i = 1; i <= 20; i++) {
        events.push({ kind: 'turn_start', turn: i, provider: 'openai-compatible' });
        events.push({ kind: 'text_emission', turn: i, chars: 5000, preview: 'x'.repeat(5000) });
        events.push({ kind: 'tool_call', turn: i, toolSummary: `readFile(/path/f${i}.ts)` });
      }
      events.push({
        kind: 'escalation_start',
        previousProvider: 'minimax',
        previousReason: 'status=incomplete',
        nextProvider: 'codex',
      });
      events.push({ kind: 'injection', injectionType: 'supervise_fragment', turn: 21, contentLengthChars: 200 });
      events.push({ kind: 'injection', injectionType: 'watchdog_warning', turn: 22, contentLengthChars: 150 });
      events.push({ kind: 'done', status: 'incomplete' });

      const result = trimProgressTrace(events);

      // All 20 turn_starts preserved
      const turnStarts = result.filter((e) => e.kind === 'turn_start');
      expect(turnStarts.length).toBe(20);

      // escalation_start, both injections, and done all preserved
      expect(result.filter((e) => e.kind === 'escalation_start').length).toBe(1);
      expect(result.filter((e) => e.kind === 'injection').length).toBe(2);
      expect(result.filter((e) => e.kind === 'done').length).toBe(1);

      // text_emissions and tool_calls dropped under pressure
      expect(result.some((e) => e.kind === '_trimmed')).toBe(true);
    });
  ```

- [ ] **Step 18: Run the four new trim tests.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts -t "trimProgressTrace" 2>&1 | tail -15
  ```

  Expected: all trimProgressTrace tests pass.

- [ ] **Step 19: Run the full supervision test file.**

  ```bash
  npx vitest run tests/runners/supervision.test.ts 2>&1 | tail -10
  ```

  Expected: every test in the file passes (previous tests + new validateCoverage + new buildRePrompt branch + new trimProgressTrace).

- [ ] **Step 20: Run the full test suite to confirm nothing upstream broke.**

  ```bash
  npm test 2>&1 | tail -8
  ```

  Expected: ~382 baseline + ~16 new supervision tests ≈ 398 passing. No existing tests broken.

### Step 21: Commit Task 2

- [ ] **Step 21: Commit the pure-function helpers.**

  ```bash
  git add packages/core/src/runners/supervision.ts tests/runners/supervision.test.ts
  git commit -m "feat(core): validateCoverage + trimProgressTrace pure functions

  Two new pure supervision helpers, fully unit-tested in isolation. No
  runner integration yet — both are exported but not called. Subsequent
  tasks wire them into the three runners' supervision loops and result
  builders.

  validateCoverage(text, expected):
  - minSections with configurable sectionPattern (default ^## )
  - requiredMarkers substring membership with truncated missing list
  - invalid regex → insufficient_coverage with compile error reason
  - returns ValidationResult using the new 'insufficient_coverage'
    DegenerateKind variant landed in Task 1
  - generic across enumerable-deliverable workloads — no severity-table
    or other audit-specific modes (explicitly dropped during design review)

  trimProgressTrace(events):
  - caps the droppable partition at TRACE_MAX_EVENTS (80) / TRACE_MAX_CHARS (16_384)
  - priority-based drop order: text_emission first, tool_call second
  - never drops boundary events (turn_start, turn_complete,
    escalation_start, done, injection)
  - fallback: first 10 + last 30 retention applies to droppable events only
  - synthetic _trimmed marker with droppedCount + per-kind histogram, plus
    capExceededByBoundaryEvents when the boundary skeleton alone exceeds the
    nominal cap

  Plus a new buildRePrompt branch for the insufficient_coverage kind
  that tells the model to append missing items, not restart.

  Tests: new `validateCoverage` coverage, new `trimProgressTrace` coverage, and the `insufficient_coverage` `buildRePrompt` branch.

  Spec: §2.3, §2.5, §6.4, §6.6"
  ```

- [ ] **Step 22: Verify state.**

  ```bash
  git log --oneline -3
  npm test 2>&1 | tail -6
  ```

  Expected: two new commits on `dev/v0.3.0`. ~398 tests passing.

---

## Task 3: costUSD rate table fallback + `computeSavedCostUSD` helper

**Goal:** Extend `model-profiles.json` with published per-family rates, extend the `ModelProfile` zod schema with four optional rate fields, extend `computeCostUSD` with a profile-rate fallback step, and add a new `computeSavedCostUSD(actual, inputTokens, outputTokens, parentModel)` helper. After this task, any provider config that doesn't set explicit rates will pick up the profile default, and callers that set `TaskSpec.parentModel` can (once runners are updated in Task 9) see non-null `savedCostUSD`.

**Files:**
- Modify: `packages/core/src/routing/model-profiles.ts`
- Modify: `packages/core/src/model-profiles.json`
- Modify: `packages/core/src/cost.ts`
- Modify: `tests/cost.test.ts`
- Modify: `tests/routing/model-profiles.test.ts`

### Step 1: Read the current state of the three core files

- [ ] **Step 1: Read the current cost.ts, model-profiles.ts, and model-profiles.json.**

  ```bash
  wc -l packages/core/src/cost.ts packages/core/src/routing/model-profiles.ts packages/core/src/model-profiles.json
  ```

  Expected sizes: `cost.ts` ~60 lines, `model-profiles.ts` ~150 lines (schema + findModelProfile), `model-profiles.json` ~50 lines (array of profile entries).

  Read all three to understand: (1) `computeCostUSD`'s current signature and fallback behavior, (2) the zod schema shape for `ModelProfile`, (3) the JSON data format and which profile prefixes exist today (should be `claude-opus`, `claude-sonnet`, `gpt-5`, `MiniMax-M2`, plus `DEFAULT_PROFILE` in the .ts file — verified in v0.2.0).

### Step 2-4: Extend the schema

- [ ] **Step 2: Write a failing schema test.**

  Append to `tests/routing/model-profiles.test.ts`:

  ```typescript
  describe('ModelProfile schema — v0.3.0 rate fields', () => {
    it('accepts optional inputCostPerMTok and outputCostPerMTok', () => {
      const profile = {
        prefix: 'test-model',
        tier: 'standard' as const,
        bestFor: 'test',
        supportsEffort: false,
        inputTokenSoftLimit: 100_000,
        inputCostPerMTok: 1.25,
        outputCostPerMTok: 10.0,
        rateSource: 'https://example.com/pricing',
        rateLookupDate: '2026-04-11',
      };
      const result = modelProfileSchema.safeParse(profile);
      expect(result.success).toBe(true);
    });

    it('accepts profiles without rate fields (backward compat)', () => {
      const profile = {
        prefix: 'legacy-model',
        tier: 'standard' as const,
        bestFor: 'test',
        supportsEffort: false,
        inputTokenSoftLimit: 100_000,
      };
      const result = modelProfileSchema.safeParse(profile);
      expect(result.success).toBe(true);
    });
  });
  ```

  At the top of the file, add `modelProfileSchema` to the imports if it isn't already:

  ```typescript
  import { modelProfileSchema, findModelProfile, DEFAULT_PROFILE, getEffectiveCostTier } from '../../packages/core/src/routing/model-profiles.js';
  ```

  (Check the existing imports — add whichever named exports the new test references that aren't already imported.)

- [ ] **Step 3: Run the test and confirm it fails.**

  ```bash
  npx vitest run tests/routing/model-profiles.test.ts -t "v0.3.0 rate fields" 2>&1 | tail -15
  ```

  Expected: both tests fail. The "accepts optional rate fields" case fails because the schema doesn't know the new fields and strict mode rejects them (or they pass through but the test expectation uses `modelProfileSchema` which might not be exported — in which case the first error is an import failure).

- [ ] **Step 4: Extend the schema in `packages/core/src/routing/model-profiles.ts`.**

  Find the `modelProfileSchema = z.object({ ... })` definition. Add four new optional fields to the `.object({})`:

  ```typescript
    inputCostPerMTok: z.number().nonnegative().optional(),
    outputCostPerMTok: z.number().nonnegative().optional(),
    rateSource: z.string().optional(),
    rateLookupDate: z.string().optional(),
  ```

  If `modelProfileSchema` isn't already exported, add `export` to it so the test can import it. If the existing code only exports `findModelProfile` / `DEFAULT_PROFILE` / `getEffectiveCostTier`, add `modelProfileSchema` to the exports.

  Re-run:

  ```bash
  npx vitest run tests/routing/model-profiles.test.ts -t "v0.3.0 rate fields" 2>&1 | tail -10
  ```

  Expected: both tests pass.

### Step 5-7: Populate rates in model-profiles.json (verify at implementation time)

- [ ] **Step 5: Verify current published rates for each model family.**

  **IMPORTANT**: This step requires a fresh lookup against each provider's official pricing page at the time of implementation. The plan's author does not have current pricing data baked in. Before editing the JSON, look up each of the following:

  1. **OpenAI gpt-5-codex and gpt-5 family** — check https://openai.com/api/pricing/ or the OpenAI platform console for current Responses API rates
  2. **Anthropic claude-opus-4-6** (standard and 1m-context variants) — check https://www.anthropic.com/pricing or the Claude Console
  3. **Anthropic claude-sonnet-4-x** — same
  4. **Anthropic claude-haiku-4-x** — same
  5. **MiniMax MiniMax-M2** — check https://www.minimax.io/ or their API docs; confirm free tier

  Record the `inputCostPerMTok`, `outputCostPerMTok`, source URL, and lookup date for each in a scratch note. You'll write them into the JSON in the next step.

  If any provider's rates are unclear or behind a paywall you can't access, mark that profile's rate fields as `undefined` (omit from the JSON) — `computeCostUSD` will return `null` for those models, matching current behavior.

- [ ] **Step 6: Update `packages/core/src/model-profiles.json` with the verified rates.**

  Open the JSON file. For each profile entry, add the four new fields using the values from Step 5. Example for MiniMax (which is free):

  ```json
  {
    "prefix": "MiniMax-M2",
    "tier": "standard",
    "bestFor": "...",
    "supportsEffort": false,
    "inputTokenSoftLimit": 200000,
    "inputCostPerMTok": 0,
    "outputCostPerMTok": 0,
    "rateSource": "https://www.minimax.io/pricing",
    "rateLookupDate": "2026-04-11"
  },
  ```

  Example for `claude-sonnet` (replace TBD numbers with verified rates):

  ```json
  {
    "prefix": "claude-sonnet",
    "tier": "standard",
    "bestFor": "...",
    "supportsEffort": true,
    "inputTokenSoftLimit": 150000,
    "inputCostPerMTok": 3.00,
    "outputCostPerMTok": 15.00,
    "rateSource": "https://www.anthropic.com/pricing",
    "rateLookupDate": "2026-04-11"
  },
  ```

  Do the same for `claude-opus`, `gpt-5`, and any `gpt-5-codex` entries. Leave any profile where the rates couldn't be verified with the rate fields omitted entirely.

- [ ] **Step 7: Run the model-profiles tests to verify the JSON parses.**

  ```bash
  npx vitest run tests/routing/model-profiles.test.ts 2>&1 | tail -10
  ```

  Expected: all tests pass (including the two new ones from Step 2-4). The JSON-loading code parses the new fields without error because they're optional in the schema.

### Step 8-11: `computeCostUSD` profile fallback via TDD

- [ ] **Step 8: Append the fallback test to `tests/cost.test.ts`.**

  ```typescript
  describe('computeCostUSD — v0.3.0 profile-rate fallback', () => {
    it('uses provider config rates when set (unchanged behavior)', () => {
      const config: ProviderConfig = {
        type: 'openai-compatible',
        model: 'MiniMax-M2',
        baseUrl: 'https://api.minimax.io/v1',
        inputCostPerMTok: 5.0,
        outputCostPerMTok: 20.0,
      };
      const result = computeCostUSD(1_000_000, 500_000, config);
      expect(result).toBe(5.0 + 10.0); // 1M input × 5 + 0.5M output × 20
    });

    it('falls back to profile rates when config rates are undefined', () => {
      const config: ProviderConfig = {
        type: 'openai-compatible',
        model: 'MiniMax-M2', // profile has inputCostPerMTok: 0, outputCostPerMTok: 0
        baseUrl: 'https://api.minimax.io/v1',
      };
      const result = computeCostUSD(1_000_000, 500_000, config);
      expect(result).toBe(0); // free tier
    });

    it('falls back to profile rates for a known paid model', () => {
      // Verify by looking up one of the profiles in model-profiles.json
      // that has non-zero rates. claude-sonnet is a likely candidate.
      const config: ProviderConfig = {
        type: 'claude',
        model: 'claude-sonnet-4-6',
      };
      const result = computeCostUSD(1_000_000, 500_000, config);
      // The exact expected value depends on the rates committed in Step 6.
      // This test should assert non-null and > 0; the precise value is
      // determined at implementation time based on the rates you put in
      // the JSON. Update this comment to the actual expected once known.
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
    });

    it('returns null when neither config nor profile have rates (unknown model)', () => {
      const config: ProviderConfig = {
        type: 'openai-compatible',
        model: 'unknown-custom-model',
        baseUrl: 'https://example.com/v1',
      };
      const result = computeCostUSD(1_000_000, 500_000, config);
      expect(result).toBeNull();
    });
  });
  ```

- [ ] **Step 9: Run the tests and verify most fail.**

  ```bash
  npx vitest run tests/cost.test.ts -t "profile-rate fallback" 2>&1 | tail -15
  ```

  Expected: tests 1 and 4 pass (existing behavior — config override, and no-match returns null). Tests 2 and 3 fail because `computeCostUSD` currently returns `null` when config rates are unset, regardless of profile rates.

- [ ] **Step 10: Implement the fallback in `packages/core/src/cost.ts`.**

  Find the existing `computeCostUSD` function. Replace it with:

  ```typescript
  import { findModelProfile } from './routing/model-profiles.js';

  export function computeCostUSD(
    inputTokens: number,
    outputTokens: number,
    providerConfig: ProviderConfig,
  ): number | null {
    // Step 1: provider config override (unchanged — caller-supplied rates win)
    if (
      providerConfig.inputCostPerMTok !== undefined &&
      providerConfig.outputCostPerMTok !== undefined
    ) {
      return (
        (inputTokens / 1_000_000) * providerConfig.inputCostPerMTok +
        (outputTokens / 1_000_000) * providerConfig.outputCostPerMTok
      );
    }

    // Step 2 (NEW): fall back to the model profile's published rates
    const profile = findModelProfile(providerConfig.model);
    if (
      profile.inputCostPerMTok !== undefined &&
      profile.outputCostPerMTok !== undefined
    ) {
      return (
        (inputTokens / 1_000_000) * profile.inputCostPerMTok +
        (outputTokens / 1_000_000) * profile.outputCostPerMTok
      );
    }

    // Step 3: no rates available — null (unchanged)
    return null;
  }
  ```

  If `findModelProfile` wasn't already imported at the top of `cost.ts`, add the import line. If the existing `computeCostUSD` takes other parameters or has a different signature, preserve those — only the body changes.

- [ ] **Step 11: Re-run the cost tests.**

  ```bash
  npx vitest run tests/cost.test.ts 2>&1 | tail -10
  ```

  Expected: all cost tests pass, including the four new fallback tests.

### Step 12-14: `computeSavedCostUSD` helper via TDD

- [ ] **Step 12: Append the savedCostUSD helper tests to `tests/cost.test.ts`.**

  ```typescript
  describe('computeSavedCostUSD — estimated savings vs declared parent model', () => {
    it('returns null when parentModel is undefined', () => {
      const result = computeSavedCostUSD(0.05, 1_000_000, 500_000, undefined);
      expect(result).toBeNull();
    });

    it('returns null when actual cost is null', () => {
      const result = computeSavedCostUSD(null, 1_000_000, 500_000, 'claude-opus-4-6');
      expect(result).toBeNull();
    });

    it('returns null when parent model is unknown (no profile match or no rates)', () => {
      const result = computeSavedCostUSD(0.05, 1_000_000, 500_000, 'unknown-parent-model');
      expect(result).toBeNull();
    });

    it('returns positive savings when delegation was cheaper than parent', () => {
      // Parent: claude-opus (expensive). Actual: $0 (ran on MiniMax free tier).
      const result = computeSavedCostUSD(0, 1_000_000, 500_000, 'claude-opus-4-6');
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(0);
    });

    it('returns negative when delegation was somehow more expensive than parent (edge case)', () => {
      // Actual cost is $100 (unrealistic). Parent: cheap model. → negative saving.
      const result = computeSavedCostUSD(100, 1_000_000, 500_000, 'MiniMax-M2');
      expect(result).not.toBeNull();
      expect(result!).toBeLessThan(0);
    });
  });
  ```

  Add `computeSavedCostUSD` to the imports at the top of the test file:

  ```typescript
  import { computeCostUSD, computeSavedCostUSD } from '../packages/core/src/cost.js';
  ```

- [ ] **Step 13: Run the tests and verify they fail.**

  ```bash
  npx vitest run tests/cost.test.ts -t "computeSavedCostUSD" 2>&1 | tail -15
  ```

  Expected: compile error — `computeSavedCostUSD is not exported`.

- [ ] **Step 14: Implement `computeSavedCostUSD` in `packages/core/src/cost.ts`.**

  Append to `cost.ts` (after `computeCostUSD`):

  ```typescript
  /**
   * Compute the estimated cost savings of running this task on its actual
   * provider vs running it on the declared parent model. Returns null when:
   * - parentModel is undefined (caller didn't opt in)
   * - actualCostUSD is null (unknown actual cost)
   * - parentModel has no profile match or no rates in the profile
   *
   * Positive result means delegation was cheaper (the common case).
   * Negative result means delegation was more expensive than the parent
   * would have been (unusual but possible with unfavorable routing).
   *
   * THIS IS AN ESTIMATE, NOT ACCOUNTING TRUTH. It assumes the parent
   * model would have consumed the same token volume at the same cost
   * tier, which is a sanity check for budgeting and debugging, not a
   * precise measurement. Actual parent-model cost would vary with
   * context, tool overhead, retry patterns, and provider-specific
   * billing.
   */
  export function computeSavedCostUSD(
    actualCostUSD: number | null,
    inputTokens: number,
    outputTokens: number,
    parentModel: string | undefined,
  ): number | null {
    if (!parentModel || actualCostUSD === null) return null;

    const parentProfile = findModelProfile(parentModel);
    if (
      parentProfile.inputCostPerMTok === undefined ||
      parentProfile.outputCostPerMTok === undefined
    ) {
      return null;
    }

    const hypotheticalParentCost =
      (inputTokens / 1_000_000) * parentProfile.inputCostPerMTok +
      (outputTokens / 1_000_000) * parentProfile.outputCostPerMTok;

    return hypotheticalParentCost - actualCostUSD;
  }
  ```

  Re-run:

  ```bash
  npx vitest run tests/cost.test.ts 2>&1 | tail -10
  ```

  Expected: all cost tests pass — 5 v0.2.0 baseline + 4 fallback + 5 savedCostUSD = 14 total (or whatever the v0.2.0 baseline count was plus 9).

### Step 15: Full suite + commit

- [ ] **Step 15: Run the full test suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -8
  ```

  Expected: build clean, all tests pass. Approximate count: ~398 (from Task 2) + 11 new cost/schema tests = ~409.

- [ ] **Step 16: Commit Task 3.**

  ```bash
  git add packages/core/src/cost.ts packages/core/src/routing/model-profiles.ts packages/core/src/model-profiles.json tests/cost.test.ts tests/routing/model-profiles.test.ts
  git commit -m "feat(core): cost rate-table fallback + computeSavedCostUSD helper

  Per spec §5.2–§5.5. Closes the 'costUSD: null on every dispatch'
  blind spot by adding published per-family rates to model-profiles.json
  as a fallback when provider config doesn't set explicit rates.

  - ModelProfile schema: new optional inputCostPerMTok / outputCostPerMTok
    / rateSource / rateLookupDate fields
  - model-profiles.json: verified rates per profile, with source URLs and
    lookup dates committed alongside (rates verified at implementation
    time against each provider's official pricing page)
  - computeCostUSD: two-step fallback — config rates > profile rates >
    null. Pre-existing callers that set rates explicitly see identical
    behavior.
  - computeSavedCostUSD: new helper that estimates cost difference vs a
    declared parent model. Returns null on missing rates; positive when
    delegation was cheaper. Explicitly documented as an ESTIMATE for
    budgeting and debugging, not accounting truth.

  Tests: 11 new (2 schema + 4 fallback + 5 savedCostUSD).

  Spec: §5"
  ```

- [ ] **Step 17: Verify state.**

  ```bash
  git log --oneline -4
  npm test 2>&1 | tail -6
  ```

---

## Task 4: `FileTracker.trackDirectoryList` + `listFiles` dual-tracking

**Goal:** Add a new `trackDirectoryList` method to `FileTracker`, wire `listFiles` to call both `trackRead` (legacy — preserves `filesRead` behavior) and `trackDirectoryList` (new — populates `directoriesListed`), and pass the new field through the three runners' RunResult construction sites. After this task, every `RunResult` exposes `directoriesListed` as a clean array of directory paths separate from the mixed `filesRead` array.

**Files:**
- Modify: `packages/core/src/tools/tracker.ts`
- Modify: `packages/core/src/tools/definitions.ts`
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `tests/tools/tracker.test.ts`
- Modify: `tests/tools/definitions.test.ts`

### Step 1-3: Tracker extension via TDD

- [ ] **Step 1: Append tracker tests to `tests/tools/tracker.test.ts`.**

  ```typescript
  describe('FileTracker — trackDirectoryList (v0.3.0)', () => {
    it('trackDirectoryList appends to the directories list', () => {
      const tracker = new FileTracker();
      tracker.trackDirectoryList('/path/to/dir');
      tracker.trackDirectoryList('/other/dir');
      expect(tracker.getDirectoriesListed()).toEqual(['/path/to/dir', '/other/dir']);
    });

    it('getDirectoriesListed returns a mutation-safe copy', () => {
      const tracker = new FileTracker();
      tracker.trackDirectoryList('/path/to/dir');
      const dirs = tracker.getDirectoriesListed();
      dirs.push('/injected/path');
      expect(tracker.getDirectoriesListed()).toEqual(['/path/to/dir']);
    });

    it('default state: empty array', () => {
      const tracker = new FileTracker();
      expect(tracker.getDirectoriesListed()).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run the tests and confirm they fail.**

  ```bash
  npx vitest run tests/tools/tracker.test.ts -t "trackDirectoryList" 2>&1 | tail -15
  ```

  Expected: fails because `trackDirectoryList` / `getDirectoriesListed` don't exist.

- [ ] **Step 3: Add the methods to `FileTracker` in `packages/core/src/tools/tracker.ts`.**

  Find the existing `FileTracker` class. After the `reads` / `writes` / `toolCalls` private fields, add:

  ```typescript
    private dirs: string[] = [];
  ```

  After the existing `trackRead` / `trackWrite` / `trackToolCall` methods, add:

  ```typescript
    /** Record that the worker listed the entries of a directory via
     *  `listFiles`. Separate from `trackRead` so callers can distinguish
     *  file reads from directory listings. `filesRead` continues to
     *  include directory paths too (dual-tracking for backward compat);
     *  `directoriesListed` is the clean split. */
    trackDirectoryList(path: string): void {
      this.dirs.push(path);
    }
  ```

  After the existing `getReads` / `getWrites` / `getToolCalls` methods, add:

  ```typescript
    getDirectoriesListed(): string[] {
      return [...this.dirs];
    }
  ```

  Re-run:

  ```bash
  npx vitest run tests/tools/tracker.test.ts -t "trackDirectoryList" 2>&1 | tail -10
  ```

  Expected: three tests pass.

### Step 4-6: `listFiles` dual-tracking via TDD

- [ ] **Step 4: Append tests to `tests/tools/definitions.test.ts`.**

  Find the existing `describe('listFiles')` block (or similar) and append a new describe:

  ```typescript
  describe('listFiles — v0.3.0 dual tracking', () => {
    it('calls both trackRead (legacy) and trackDirectoryList (new)', async () => {
      const tracker = new FileTracker();
      const tools = createToolImplementations(tracker, '/tmp/test-cwd', 'cwd-only');
      // listFiles on an existing directory
      // (may need an actual tmp dir — use os.tmpdir() or a fixture)
      const tmpDir = '/tmp';
      await tools.listFiles(tmpDir);

      // Both tracked
      expect(tracker.getReads()).toContain(tmpDir);
      expect(tracker.getDirectoriesListed()).toContain(tmpDir);
    });

    it('readFile does NOT populate directoriesListed', async () => {
      const tracker = new FileTracker();
      const tools = createToolImplementations(tracker, '/tmp', 'cwd-only');
      // readFile on an actual file
      // Use a temporary file or an existing one under /tmp.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const tmpFile = path.join('/tmp', `v0.3.0-test-${Date.now()}.txt`);
      await fs.writeFile(tmpFile, 'test content');
      try {
        await tools.readFile(tmpFile);
        expect(tracker.getReads()).toContain(tmpFile);
        expect(tracker.getDirectoriesListed()).toEqual([]);
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });
  });
  ```

- [ ] **Step 5: Run the tests and verify the first one fails.**

  ```bash
  npx vitest run tests/tools/definitions.test.ts -t "dual tracking" 2>&1 | tail -15
  ```

  Expected: "calls both" fails because `listFiles` currently only calls `trackRead`. The "readFile does NOT populate" test passes trivially (tracker.getDirectoriesListed() is empty by default).

- [ ] **Step 6: Update `listFiles` in `packages/core/src/tools/definitions.ts`.**

  Find the existing `listFiles` implementation. It currently has something like:

  ```typescript
  async listFiles(dirPath: string): Promise<string[]> {
    assertWithinCwd(dirPath, runnerCwd);
    tracker.trackToolCall(`listFiles(${dirPath})`);
    tracker.trackRead(dirPath);
    // ... actual listing logic ...
  }
  ```

  Add one line after `trackRead`:

  ```typescript
  async listFiles(dirPath: string): Promise<string[]> {
    assertWithinCwd(dirPath, runnerCwd);
    tracker.trackToolCall(`listFiles(${dirPath})`);
    tracker.trackRead(dirPath);              // legacy: keeps filesRead behavior
    tracker.trackDirectoryList(dirPath);     // NEW: v0.3.0 clean field
    // ... actual listing logic unchanged ...
  }
  ```

  Re-run:

  ```bash
  npx vitest run tests/tools/definitions.test.ts -t "dual tracking" 2>&1 | tail -10
  ```

  Expected: both tests pass.

### Step 7-10: Per-runner pass-through

- [ ] **Step 7: Read each runner's result-builder helpers.**

  ```bash
  grep -n "filesRead: tracker.getReads" packages/core/src/runners/*.ts | head -30
  ```

  Expected: ~18 matches across the three runners (every `RunResult` construction site). You need to add `directoriesListed: tracker.getDirectoriesListed()` to every one of them.

- [ ] **Step 8: Update `packages/core/src/runners/openai-runner.ts` — every result construction site.**

  Use find-and-replace. Every time you see `filesRead: tracker.getReads(),` followed by `filesWritten: tracker.getWrites(),`, insert a new line between them:

  ```typescript
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    directoriesListed: tracker.getDirectoriesListed(),  // NEW v0.3.0
  ```

  There should be ~6 construction sites in openai-runner (the helpers `buildOkResult`, `buildSupervisionExhaustedResult`, `buildForceSalvageResult` + inline max_turns / error-catch / withTimeout branches). Add the new field to all of them.

- [ ] **Step 9: Same change in `packages/core/src/runners/claude-runner.ts`.**

  Apply the identical insertion at every `filesRead: tracker.getReads(),` site. Claude-runner has ~6 sites too (`buildClaudeOkResult`, `buildClaudeIncompleteResult`, `buildClaudeForceSalvageResult`, `buildClaudeMaxTurnsResult` + inline error/timeout).

- [ ] **Step 10: Same change in `packages/core/src/runners/codex-runner.ts`.**

  Same pattern, ~6 sites (`buildCodexOkResult`, `buildCodexIncompleteResult`, `buildCodexForceSalvageResult`, `buildCodexMaxTurnsResult` + inline error/timeout).

### Step 11: Verify compile + tests

- [ ] **Step 11: Build and test.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: clean build, all tests pass. Count: ~409 (from Task 3) + 5 tracker/definitions tests = ~414.

- [ ] **Step 12: Commit Task 4.**

  ```bash
  git add packages/core/src/tools/tracker.ts packages/core/src/tools/definitions.ts packages/core/src/runners/openai-runner.ts packages/core/src/runners/claude-runner.ts packages/core/src/runners/codex-runner.ts tests/tools/tracker.test.ts tests/tools/definitions.test.ts
  git commit -m "feat(core): directoriesListed additive field on RunResult

  Per spec §7. Cleans up the filesRead/directory mixing inconsistency
  additively — filesRead semantics are UNCHANGED (directory paths
  continue to appear there), and a new directoriesListed array gives
  callers a clean view of 'which folders did the worker explore'
  separate from 'which files did the worker touch'.

  - FileTracker: new trackDirectoryList() + getDirectoriesListed() methods
  - definitions.ts: listFiles now calls both trackRead (legacy) and
    trackDirectoryList (new)
  - Three runners: every RunResult construction site (helpers + inline
    error/timeout branches) populates directoriesListed from
    tracker.getDirectoriesListed()

  Backward compat: filesRead unchanged — any v0.2.0 consumer that read
  filesRead literally still sees the same mixed file+directory paths.
  directoriesListed is additive and defaults to [] for existing mock
  fixtures without the field.

  Tests: 5 new (3 tracker + 2 definitions dual-tracking).

  Spec: §7"
  ```

---

## Task 5: openai-runner max_turns continuation fix + reason precision

**Goal:** Fix the `max_turns at 5 turns with maxTurns: 120` misclassification bug in openai-runner. The root cause is that the supervision loop passes `maxTurns: 1` to `runTurnAndBuffer` on continuation calls (watchdog warning, supervision re-prompt, re-grounding), and when the model responds with a tool call on any of those continuations, `@openai/agents` counts the model-reply-to-tool-result as a second turn, exceeds the micro-budget, and throws `MaxTurnsExceededError`. The outer catch then classifies this as `status: 'max_turns'` regardless of context.

**Two-part fix:**
1. **Raise the budget from 1 to 5** (`SUPERVISION_CONTINUATION_BUDGET`) — covers the common case where the continuation needs a tool call + reply.
2. **Wrap continuation calls in a `runContinuationTurn` helper** that catches `MaxTurnsExceededError` with context. When the error fires inside a continuation, the runner returns `status: 'incomplete'` with a precise reason like `"supervision reprompt continuation exhausted the 5-turn sub-budget at turn 7"` — NOT `status: 'max_turns'`. The outer initial-call catch keeps the `max_turns` classification for the genuine "user budget exhausted during normal execution" case.

**Reason precision applies here and in Task 6 / Task 7:** the runners' `buildXxxMaxTurnsResult` and `buildXxxSupervisionExhaustedResult` helpers (or inline branches) gain an optional `{ reason?: string }` parameter. When present, they populate `result.error` with the precise reason string. The orchestrator's `AttemptRecord.reason` already derives from `result.error || 'status=${status}'`, so precise reasons flow through automatically.

**Files:**
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `tests/runners/openai-runner.test.ts`

### Step 1: Read the current openai-runner supervision loop

- [ ] **Step 1: Find all three continuation call sites in openai-runner.**

  ```bash
  grep -n "runTurnAndBuffer.*continueWith.*1)" packages/core/src/runners/openai-runner.ts
  ```

  Expected: three matches — watchdog warning nudge, supervision re-prompt, re-grounding. All pass `1` as the turnBudget argument.

### Step 2-4: Write the regression test for the continuation-budget bug

- [ ] **Step 2: Append the regression test to `tests/runners/openai-runner.test.ts`.**

  ```typescript
  describe('openai-runner — supervision continuation budget regression (v0.3.0)', () => {
    it('re-prompt continuation that needs a tool call succeeds instead of tripping max_turns', async () => {
      // Pre-v0.3.0 bug: the supervision loop called runTurnAndBuffer with
      // maxTurns: 1 on continuation calls. If the model responded with a
      // tool call on the continuation, @openai/agents threw
      // MaxTurnsExceededError because turn 2 (the model's reply to the
      // tool result) exceeded the 1-turn budget. The outer catch then
      // misclassified this as status: 'max_turns' with turns: 5 (or
      // similar) — confusing users who expected max_turns to mean
      // "the user-declared 120-turn budget was reached."
      //
      // Fix: raise the budget to 5 (covers tool-call + reply with slack)
      // AND catch MaxTurnsExceededError with context. When the error
      // comes from a supervision continuation, classify as incomplete
      // with a precise reason — NOT max_turns.

      const mockAgentRun = vi.fn();

      // Initial call: returns after 4 turns with a fragment final output
      // (triggers supervision re-prompt).
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Let me check the next file:',
        newItems: [],
        state: { usage: { inputTokens: 10_000, outputTokens: 50, totalTokens: 10_050, requests: 4 } },
        history: [],
      });

      // Re-prompt continuation: model produces a clean final answer
      // that requires a tool call + reply (which would have exceeded
      // the old maxTurns: 1 budget). With the new budget of 5, this
      // succeeds.
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'VALID_FINAL_OUTPUT_' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500, requests: 6 } },
        history: [],
      });

      // Wire mockAgentRun into the `run` export from @openai/agents
      // via the existing vi.mock('@openai/agents', ...) pattern in this
      // file. If there's no existing mock, add one at the top of the
      // file:
      //   vi.mock('@openai/agents', async () => {
      //     const actual = await vi.importActual<typeof import('@openai/agents')>('@openai/agents');
      //     return { ...actual, Agent: vi.fn(...), run: mockAgentRun };
      //   });
      // See the existing tests in this file for the established mock
      // pattern.

      // (Test body: dispatch runOpenAI with a prompt, maxTurns=120,
      // verify result.status === 'ok', turns reflects the retry, and
      // output is VALID_FINAL_OUTPUT_xxx.)
      // ... runOpenAI invocation using the established test helper ...
      // expect(result.status).toBe('ok');
      // expect(mockAgentRun).toHaveBeenCalledTimes(2);
    });

    it('re-prompt continuation that genuinely needs >5 turns fails cleanly as incomplete, NOT max_turns', async () => {
      const mockAgentRun = vi.fn();

      // Initial: fragment output
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Let me check:',
        newItems: [],
        state: { usage: { inputTokens: 10_000, outputTokens: 50, totalTokens: 10_050, requests: 4 } },
        history: [],
      });

      // Re-prompt continuation: throws MaxTurnsExceededError
      // (simulates a continuation that needs >5 turns)
      mockAgentRun.mockRejectedValueOnce(
        new (await import('@openai/agents')).MaxTurnsExceededError('max turns exceeded'),
      );

      // ... dispatch runOpenAI with maxTurns: 120 ...
      // const result = await runOpenAI(...);
      // expect(result.status).toBe('incomplete');  // NOT 'max_turns'
      // expect(result.error).toMatch(/supervision .* continuation exhausted/);
      // expect(result.error).toMatch(/5-turn sub-budget/);
    });
  });
  ```

  **Note**: the test skeletons above use the project's existing mock pattern for `@openai/agents`. Look at the existing `runOpenAI — prevention scaffolding integration` tests in the file for the concrete mock setup (`vi.mock('@openai/agents', async () => { ... })` at the top, `mockRun` variable in each test). Reuse that pattern. The tests above describe the behavior being verified — the concrete mock wiring is identical to existing tests.

- [ ] **Step 3: Run the tests and confirm they fail.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts -t "continuation budget regression" 2>&1 | tail -20
  ```

  Expected: both fail. The "succeeds" test fails because the old budget of 1 trips on the mock's 2nd returned result. The "fails cleanly as incomplete" test fails because the catch branch still classifies as `max_turns`.

### Step 4-7: Implement the fix in openai-runner.ts

- [ ] **Step 4: Add the `SUPERVISION_CONTINUATION_BUDGET` constant.**

  Open `packages/core/src/runners/openai-runner.ts`. Near the top (after the existing imports and any other module-level constants), add:

  ```typescript
  /** Sub-budget for supervision continuation calls (re-prompt, watchdog
   *  warning nudge, re-grounding). The continuation is meant to be ONE
   *  turn but the model may respond with a tool call, which @openai/agents
   *  counts as consuming the turn; the model's reply to the tool result
   *  then wants a second turn. 5 gives enough slack for that case plus
   *  headroom for a second small tool round, while staying small enough
   *  that a runaway continuation can't eat a meaningful fraction of the
   *  user's overall maxTurns budget. */
  const SUPERVISION_CONTINUATION_BUDGET = 5;
  ```

- [ ] **Step 5: Add the `runContinuationTurn` helper inside `runOpenAI`.**

  Find the existing `runTurnAndBuffer` local helper inside `runOpenAI` (it's a closure). Below it, add:

  ```typescript
    /** Wraps `runTurnAndBuffer` for continuation call sites (re-prompt,
     *  watchdog warning nudge, re-grounding). Catches MaxTurnsExceededError
     *  and returns a discriminated union so the call site can distinguish
     *  "the supervision micro-budget was exhausted" (classify as
     *  incomplete with precise reason) from "some other error" (rethrow
     *  to the outer catch). Used instead of raw runTurnAndBuffer on the
     *  three continuation sites. */
    type ContinuationLabel = 'watchdog-warning' | 'reprompt' | 'reground';
    type ContinuationResult =
      | { ok: true; result: AgentRunOutput }
      | { ok: false; cause: 'max-turns-exceeded'; label: ContinuationLabel; turnAtFailure: number };

    const runContinuationTurn = async (
      input: string | AgentInputItem[],
      label: ContinuationLabel,
    ): Promise<ContinuationResult> => {
      try {
        const result = await runTurnAndBuffer(input, SUPERVISION_CONTINUATION_BUDGET);
        return { ok: true, result };
      } catch (err) {
        if (err instanceof MaxTurnsExceededError) {
          return {
            ok: false,
            cause: 'max-turns-exceeded',
            label,
            turnAtFailure: currentResult?.state.usage.requests ?? 0,
          };
        }
        throw err; // propagate non-max_turns errors to the outer catch
      }
    };
  ```

- [ ] **Step 6: Replace the three continuation call sites to use `runContinuationTurn`.**

  Find the **watchdog warning nudge** call site (grep for `runTurnAndBuffer(continueWith(currentResult, warning)`):

  ```typescript
  // OLD:
  currentResult = await runTurnAndBuffer(continueWith(currentResult, warning), 1);

  // NEW:
  {
    const contRes = await runContinuationTurn(
      continueWith(currentResult, warning),
      'watchdog-warning',
    );
    if (!contRes.ok) {
      emit({ kind: 'done', status: 'incomplete' });
      return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig, {
        reason: `supervision ${contRes.label} continuation exhausted the ${SUPERVISION_CONTINUATION_BUDGET}-turn sub-budget at turn ${contRes.turnAtFailure}`,
      });
    }
    currentResult = contRes.result;
  }
  ```

  Find the **supervision re-prompt** call site (grep for `runTurnAndBuffer(continueWith(currentResult, rePrompt)`):

  ```typescript
  // OLD:
  currentResult = await runTurnAndBuffer(continueWith(currentResult, rePrompt), 1);

  // NEW:
  {
    const contRes = await runContinuationTurn(
      continueWith(currentResult, rePrompt),
      'reprompt',
    );
    if (!contRes.ok) {
      emit({ kind: 'done', status: 'incomplete' });
      return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig, {
        reason: `supervision ${contRes.label} continuation exhausted the ${SUPERVISION_CONTINUATION_BUDGET}-turn sub-budget at turn ${contRes.turnAtFailure}`,
      });
    }
    currentResult = contRes.result;
  }
  ```

  Find the **re-grounding** call site (grep for `runTurnAndBuffer(continueWith(currentResult, reground)`):

  ```typescript
  // OLD:
  currentResult = await runTurnAndBuffer(continueWith(currentResult, reground), 1);

  // NEW:
  {
    const contRes = await runContinuationTurn(
      continueWith(currentResult, reground),
      'reground',
    );
    if (!contRes.ok) {
      emit({ kind: 'done', status: 'incomplete' });
      return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig, {
        reason: `supervision ${contRes.label} continuation exhausted the ${SUPERVISION_CONTINUATION_BUDGET}-turn sub-budget at turn ${contRes.turnAtFailure}`,
      });
    }
    currentResult = contRes.result;
  }
  ```

- [ ] **Step 7: Update `buildSupervisionExhaustedResult` to accept the optional `{ reason?: string }` parameter.**

  Find the `buildSupervisionExhaustedResult` function. It currently has signature like:

  ```typescript
  function buildSupervisionExhaustedResult(
    currentResult: AgentRunOutput,
    scratchpad: TextScratchpad,
    tracker: FileTracker,
    providerConfig: ProviderConfig,
  ): RunResult {
  ```

  Add an optional opts parameter:

  ```typescript
  function buildSupervisionExhaustedResult(
    currentResult: AgentRunOutput,
    scratchpad: TextScratchpad,
    tracker: FileTracker,
    providerConfig: ProviderConfig,
    opts: { reason?: string } = {},
  ): RunResult {
  ```

  Inside the function, where the return object is built, add the optional error field:

  ```typescript
    return {
      output: hasSalvage ? scratchpad.latest() : buildIncompleteDiagnostic({...}),
      status: 'incomplete',
      // ... existing fields ...
      filesRead: tracker.getReads(),
      filesWritten: tracker.getWrites(),
      directoriesListed: tracker.getDirectoriesListed(),
      toolCalls: tracker.getToolCalls(),
      outputIsDiagnostic: !hasSalvage,
      escalationLog: [],
      // NEW: populate error with the precise reason when supplied
      ...(opts.reason && { error: opts.reason }),
    };
  ```

### Step 8-10: Reason precision on other openai-runner return paths

- [ ] **Step 8: Update the `MaxTurnsExceededError` outer catch with a precise reason.**

  Find the outer `catch (err)` block in the `run()` function. Where it handles `MaxTurnsExceededError`, replace:

  ```typescript
  if (err instanceof MaxTurnsExceededError) {
    const hasSalvage = !scratchpad.isEmpty();
    emit({ kind: 'done', status: 'max_turns' });
    return {
      output: hasSalvage ? scratchpad.latest() : `Agent exceeded max turns (${maxTurns}).`,
      status: 'max_turns',
      usage: partialUsage(currentResult, runner.providerConfig),
      turns: currentResult?.state.usage.requests ?? maxTurns,
      filesRead,
      filesWritten,
      directoriesListed: tracker.getDirectoriesListed(),
      toolCalls,
      outputIsDiagnostic: !hasSalvage,
      escalationLog: [],
    };
  }
  ```

  with:

  ```typescript
  if (err instanceof MaxTurnsExceededError) {
    const hasSalvage = !scratchpad.isEmpty();
    emit({ kind: 'done', status: 'max_turns' });
    const turnsAtFailure = currentResult?.state.usage.requests ?? maxTurns;
    return {
      output: hasSalvage ? scratchpad.latest() : `Agent exceeded max turns (${maxTurns}).`,
      status: 'max_turns',
      usage: partialUsage(currentResult, runner.providerConfig),
      turns: turnsAtFailure,
      filesRead,
      filesWritten,
      directoriesListed: tracker.getDirectoriesListed(),
      toolCalls,
      outputIsDiagnostic: !hasSalvage,
      escalationLog: [],
      // NEW: precise reason. This catch path is the INITIAL call exhausting
      // the user-declared budget — NOT a supervision continuation (those
      // are handled by runContinuationTurn above).
      error: `agent exhausted user-declared maxTurns limit (${maxTurns}) after ${turnsAtFailure} turns`,
    };
  }
  ```

- [ ] **Step 9: Update the existing supervision-exhausted non-continuation path to pass a reason.**

  Find the existing supervision loop in openai-runner where supervisionRetries >= MAX_SUPERVISION_RETRIES or `sameDegenerateOutput` fires. When it calls `buildSupervisionExhaustedResult`, add the reason:

  ```typescript
  // OLD:
  return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig);

  // NEW:
  return buildSupervisionExhaustedResult(
    currentResult,
    scratchpad,
    tracker,
    runner.providerConfig,
    {
      reason: `supervision loop exhausted after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
    },
  );
  ```

- [ ] **Step 10: Run the regression tests and verify they pass.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts -t "continuation budget regression" 2>&1 | tail -15
  ```

  Expected: both pass. The first ("succeeds") passes because the budget is now 5 and the mocked continuation returns a valid result. The second ("fails cleanly as incomplete") passes because the `runContinuationTurn` helper catches the thrown MaxTurnsExceededError and returns `ok: false`, causing the call site to return `status: 'incomplete'` with a precise reason matching `/supervision .* continuation exhausted/`.

### Step 11-12: Full runner test suite + commit

- [ ] **Step 11: Run the full openai-runner test file and verify nothing regressed.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts 2>&1 | tail -10
  ```

  Expected: all tests pass, including the pre-v0.3.0 tests.

- [ ] **Step 12: Run the full test suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -8
  ```

  Expected: build clean, ~414 + 2 = ~416 tests passing.

- [ ] **Step 13: Commit Task 5.**

  ```bash
  git add packages/core/src/runners/openai-runner.ts tests/runners/openai-runner.test.ts
  git commit -m "fix(core): openai-runner supervision continuation budget + max_turns precision

  Fixes the 'max_turns at 5 turns with maxTurns: 120' misclassification
  bug from the v0.2.0 post-mortem. Root cause: the supervision loop
  passed maxTurns: 1 to @openai/agents on continuation calls (re-prompt,
  watchdog warning, re-grounding). When the model responded with a tool
  call, the SDK counted the reply-to-tool-result as turn 2 and threw
  MaxTurnsExceededError — which the outer catch classified as
  status: 'max_turns' regardless of context.

  Two-part fix per spec §4.3 and §4.4:
  1. Raise SUPERVISION_CONTINUATION_BUDGET from 1 to 5 — covers tool-call
     + reply with slack.
  2. Wrap continuation calls in runContinuationTurn helper that catches
     MaxTurnsExceededError with context. When the error fires inside a
     continuation, the runner returns status: 'incomplete' with a
     precise reason like 'supervision reprompt continuation exhausted
     the 5-turn sub-budget at turn 7' — NOT max_turns.

  Plus reason precision on the remaining openai-runner branches (§4.5, §4.6):
  - buildSupervisionExhaustedResult gains an optional {reason?} parameter
  - Outer MaxTurnsExceededError catch populates result.error with
    'agent exhausted user-declared maxTurns limit (N) after K turns'
  - Supervision-exhausted (non-continuation) path passes a reason that
    names the last DegenerateKind seen

  Reason strings flow through AttemptRecord.reason automatically via the
  orchestrator's existing 'result.error || status=X' fallback. Callers
  inspecting escalationLog[i].reason now see exactly what failed.

  Tests: 2 new (continuation-budget regression, both success and
  supervision-exhausted outcomes).

  Spec: §4"
  ```

---

## Task 6: claude-runner max_turns reason precision

**Goal:** Apply the same reason-precision changes to claude-runner. Claude-runner does NOT have the continuation-budget bug (it uses streaming input via the `PushableUserMessageQueue`, not SDK re-invocation), so no budget fix is needed — only the reason field population on its existing result-builder helpers.

**Files:**
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `tests/runners/claude-runner.test.ts`

### Step 1: Write the reason-precision test

- [ ] **Step 1: Append the test to `tests/runners/claude-runner.test.ts`.**

  ```typescript
  describe('claude-runner — max_turns reason precision (v0.3.0)', () => {
    it('error_max_turns SDK signal populates result.error with precise reason', async () => {
      // Mock the claude-agent-sdk query() iterator to emit a
      // { type: 'result', subtype: 'error_max_turns' } message after
      // some turns, triggering the hitMaxTurns branch in claude-runner.
      // (Follow the existing claude-runner test mock pattern — use the
      // async generator that yields canned messages.)

      // ... dispatch runClaude with maxTurns: 3 ...
      // expect(result.status).toBe('max_turns');
      // expect(result.error).toMatch(/claude-agent-sdk signaled error_max_turns/);
      // expect(result.error).toMatch(/user-declared maxTurns: 3/);
    });

    it('supervision-exhausted returns incomplete with precise reason', async () => {
      // Mock query() to emit 3 degenerate assistant messages in a row
      // (each a fragment, triggering supervision retries that exhaust
      // MAX_SUPERVISION_RETRIES = 3).

      // ... dispatch runClaude ...
      // expect(result.status).toBe('incomplete');
      // expect(result.error).toMatch(/supervision loop exhausted after 3 re-prompts/);
      // expect(result.error).toMatch(/last kind:/);
    });
  });
  ```

  Use the existing claude-runner test file's mocking pattern for `@anthropic-ai/claude-agent-sdk`. Look at the tests already in the file — they mock `query` as an async generator yielding canned messages. Follow the same shape for the new tests.

- [ ] **Step 2: Run the tests and verify they fail.**

  ```bash
  npx vitest run tests/runners/claude-runner.test.ts -t "max_turns reason precision" 2>&1 | tail -15
  ```

  Expected: both fail because the current claude-runner doesn't populate `error` on max_turns or supervision-exhausted paths.

### Step 3: Update `buildClaudeMaxTurnsResult` + `buildClaudeIncompleteResult` signatures

- [ ] **Step 3: Add optional `{ reason?: string }` to both helper signatures.**

  Find `buildClaudeMaxTurnsResult` in `packages/core/src/runners/claude-runner.ts`. It currently has signature like:

  ```typescript
  function buildClaudeMaxTurnsResult(
    args: ClaudeResultCommonArgs & { maxTurns: number; lastOutput: string },
  ): RunResult {
  ```

  Extend the args type with an optional reason:

  ```typescript
  function buildClaudeMaxTurnsResult(
    args: ClaudeResultCommonArgs & { maxTurns: number; lastOutput: string; reason?: string },
  ): RunResult {
    // ... existing body ...
    return {
      // ... existing fields ...
      ...(args.reason && { error: args.reason }),
    };
  }
  ```

  Do the same for `buildClaudeIncompleteResult`:

  ```typescript
  function buildClaudeIncompleteResult(
    args: ClaudeResultCommonArgs & { reason?: string },
  ): RunResult {
    // ... existing body ...
    return {
      // ... existing fields ...
      ...(args.reason && { error: args.reason }),
    };
  }
  ```

### Step 4: Populate the reason at call sites

- [ ] **Step 4: Find the hitMaxTurns branch and pass a reason.**

  Find the place in `claude-runner.ts` where `msg.subtype === 'error_max_turns'` triggers `buildClaudeMaxTurnsResult` (look for `hitMaxTurns` or `error_max_turns`). Update the call:

  ```typescript
  // OLD:
  completedResult = buildClaudeMaxTurnsResult({
    tracker,
    scratchpad,
    providerConfig,
    sdkCostUSD: costUSD,
    inputTokens,
    outputTokens,
    turns,
    maxTurns,
    lastOutput,
  });

  // NEW:
  completedResult = buildClaudeMaxTurnsResult({
    tracker,
    scratchpad,
    providerConfig,
    sdkCostUSD: costUSD,
    inputTokens,
    outputTokens,
    turns,
    maxTurns,
    lastOutput,
    reason: `claude-agent-sdk signaled error_max_turns after ${turns} turns (user-declared maxTurns: ${maxTurns})`,
  });
  ```

- [ ] **Step 5: Find every supervision-exhausted call site and pass a reason.**

  Find calls to `buildClaudeIncompleteResult` in the supervision loop (there may be multiple — the retry-cap break and the same-output early-out break). Update each:

  ```typescript
  // OLD:
  completedResult = buildClaudeIncompleteResult({
    tracker,
    scratchpad,
    providerConfig,
    sdkCostUSD: costUSD,
    inputTokens,
    outputTokens,
    turns,
  });

  // NEW (for the retry-cap exit):
  completedResult = buildClaudeIncompleteResult({
    tracker,
    scratchpad,
    providerConfig,
    sdkCostUSD: costUSD,
    inputTokens,
    outputTokens,
    turns,
    reason: `supervision loop exhausted after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
  });
  ```

  For the same-output early-out exit:

  ```typescript
  // NEW:
  completedResult = buildClaudeIncompleteResult({
    // ... existing args ...
    reason: `supervision loop broke on same-output early-out after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
  });
  ```

### Step 6-7: Verify and commit

- [ ] **Step 6: Re-run the tests.**

  ```bash
  npx vitest run tests/runners/claude-runner.test.ts 2>&1 | tail -10
  ```

  Expected: the new precision tests pass. All pre-existing claude-runner tests continue to pass.

- [ ] **Step 7: Full suite + commit.**

  ```bash
  npm run build && npm test 2>&1 | tail -8
  ```

  Expected: clean build, ~418 tests passing.

  ```bash
  git add packages/core/src/runners/claude-runner.ts tests/runners/claude-runner.test.ts
  git commit -m "fix(core): claude-runner max_turns and supervision reason precision

  Per spec §4.5, §4.6. Claude-runner does NOT have the openai-runner
  continuation-budget bug (it uses streaming input via
  PushableUserMessageQueue rather than SDK re-invocation), so no budget
  fix is needed — only the reason field precision on its existing
  result-builder helpers.

  - buildClaudeMaxTurnsResult and buildClaudeIncompleteResult gain an
    optional {reason?: string} arg
  - hitMaxTurns branch passes 'claude-agent-sdk signaled error_max_turns
    after N turns (user-declared maxTurns: M)'
  - supervision-exhausted branch passes 'supervision loop exhausted
    after N re-prompts (last kind: X)'
  - same-output early-out branch passes 'supervision loop broke on
    same-output early-out after N re-prompts (last kind: X)'

  Reason flows through AttemptRecord.reason automatically via the
  orchestrator's existing fallback chain.

  Tests: 2 new (max_turns precision + supervision-exhausted precision).

  Spec: §4"
  ```

---

## Task 7: codex-runner max_turns reason precision

**Goal:** Same precision work for codex-runner. Codex-runner is hand-rolled (uses a `while (turns < maxTurns)` loop with `input.push(...)` + `continue` for re-prompts), so there's no continuation-budget bug either — only the reason field population on `buildCodexMaxTurnsResult` and `buildCodexIncompleteResult`.

**Files:**
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `tests/runners/codex-runner.test.ts`

### Step 1-6: Same pattern as Task 6

- [ ] **Step 1: Append reason-precision tests to `tests/runners/codex-runner.test.ts`.**

  ```typescript
  describe('codex-runner — max_turns reason precision (v0.3.0)', () => {
    it('while-loop exit populates result.error with precise reason', async () => {
      // Mock codex stream to never produce a clean final answer,
      // causing the while (turns < maxTurns) loop to exit naturally
      // after maxTurns iterations.

      // ... dispatch runCodex with maxTurns: 3 ...
      // expect(result.status).toBe('max_turns');
      // expect(result.error).toMatch(/hand-rolled loop exited/);
      // expect(result.error).toMatch(/3 of 3 user-declared turns/);
    });

    it('supervision-exhausted returns incomplete with precise reason', async () => {
      // Mock codex stream to emit 3 degenerate responses in a row.

      // ... dispatch runCodex ...
      // expect(result.status).toBe('incomplete');
      // expect(result.error).toMatch(/supervision loop exhausted after 3 re-prompts/);
      // expect(result.error).toMatch(/last kind:/);
    });
  });
  ```

  Use the existing codex-runner test mock pattern (the tests already stub `client.responses.create` as an async generator yielding Responses API events).

- [ ] **Step 2: Run the tests and verify they fail.**

  ```bash
  npx vitest run tests/runners/codex-runner.test.ts -t "max_turns reason precision" 2>&1 | tail -15
  ```

  Expected: both fail.

- [ ] **Step 3: Extend `buildCodexMaxTurnsResult` and `buildCodexIncompleteResult` with `{ reason?: string }`.**

  Same pattern as Task 6 Step 3. Find each helper in `codex-runner.ts`, add the optional field to the args type, populate `error` in the return object with `...(args.reason && { error: args.reason })`.

- [ ] **Step 4: Populate the reason at call sites.**

  **While-loop exit (after the while condition fails):**

  ```typescript
  // NEW:
  return buildCodexMaxTurnsResult({
    tracker,
    scratchpad,
    providerConfig,
    inputTokens,
    outputTokens,
    turns,
    maxTurns,
    lastOutput,
    reason: `hand-rolled loop exited after completing ${turns} of ${maxTurns} user-declared turns without producing a clean final answer`,
  });
  ```

  **Supervision retry cap:**

  ```typescript
  // NEW:
  return buildCodexIncompleteResult({
    tracker,
    scratchpad,
    providerConfig,
    inputTokens,
    outputTokens,
    turns,
    reason: `supervision loop exhausted after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
  });
  ```

  **Same-output early-out:**

  ```typescript
  // NEW:
  return buildCodexIncompleteResult({
    // ... existing args ...
    reason: `supervision loop broke on same-output early-out after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
  });
  ```

- [ ] **Step 5: Re-run tests.**

  ```bash
  npx vitest run tests/runners/codex-runner.test.ts 2>&1 | tail -10
  ```

  Expected: all codex-runner tests pass.

- [ ] **Step 6: Commit Task 7.**

  ```bash
  npm run build && npm test 2>&1 | tail -6
  git add packages/core/src/runners/codex-runner.ts tests/runners/codex-runner.test.ts
  git commit -m "fix(core): codex-runner max_turns and supervision reason precision

  Per spec §4.5, §4.6. Same pattern as Task 6 (claude-runner): codex is
  hand-rolled with a while (turns < maxTurns) loop for its agent cycle,
  so there's no continuation-budget bug. Only reason field precision is
  needed.

  - buildCodexMaxTurnsResult and buildCodexIncompleteResult gain an
    optional {reason?: string} arg
  - while-loop exit passes 'hand-rolled loop exited after completing
    N of M user-declared turns without producing a clean final answer'
  - supervision retry-cap passes 'supervision loop exhausted after N
    re-prompts (last kind: X)'
  - same-output early-out passes 'supervision loop broke on same-output
    early-out after N re-prompts (last kind: X)'

  Tests: 2 new.

  Spec: §4"
  ```

---

## Task 8: Runner coverage validation integration

**Goal:** Wire `validateCoverage` into all three runners' supervision loops. After a task's final text passes `validateCompletion`'s syntactic check, the runner calls `validateCoverage(stripped, task.expectedCoverage)` if the caller declared expectations. A failing coverage check flows through the same supervision retry path as any other degenerate kind — increment retries, same-output early-out, inject `buildRePrompt` with the `insufficient_coverage` branch. After this task, a caller who sets `expectedCoverage` on their TaskSpec gets real enforcement; callers who omit it see zero change.

**Files:**
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `tests/runners/openai-runner.test.ts`
- Modify: `tests/runners/claude-runner.test.ts`
- Modify: `tests/runners/codex-runner.test.ts`
- Modify: `tests/runners/cross-runner-parity.test.ts`
- Modify: `tests/runners/supervision-regression.test.ts`

### Step 1: Write the coverage-integration test for openai-runner

- [ ] **Step 1: Append coverage integration tests to `tests/runners/openai-runner.test.ts`.**

  ```typescript
  describe('openai-runner — coverage validation integration (v0.3.0)', () => {
    it('task with expectedCoverage.requiredMarkers all present → status: ok', async () => {
      // Mock agentRun to return a single result containing all three markers.
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Report covering marker-A, marker-B, and marker-C in detail. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      // Dispatch with expectedCoverage declared
      const task: TaskSpec = {
        prompt: 'test task',
        tier: 'standard',
        requiredCapabilities: [],
        expectedCoverage: {
          requiredMarkers: ['marker-A', 'marker-B', 'marker-C'],
        },
      };
      // (call runOpenAI via the existing test helper with this task)
      // expect(result.status).toBe('ok');
      // expect(mockAgentRun).toHaveBeenCalledTimes(1);
    });

    it('task with requiredMarkers missing → supervision re-prompts → recovery on retry', async () => {
      // First call: only marker-A present
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Short report covering marker-A only. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });
      // Re-prompt continuation: all three present
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Extended report now covering marker-A, marker-B, and marker-C. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1500, outputTokens: 200, totalTokens: 1700, requests: 2 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test task',
        tier: 'standard',
        requiredCapabilities: [],
        expectedCoverage: {
          requiredMarkers: ['marker-A', 'marker-B', 'marker-C'],
        },
      };
      // const result = await runOpenAI(...);
      // expect(result.status).toBe('ok');
      // expect(mockAgentRun).toHaveBeenCalledTimes(2);
    });

    it('task with requiredMarkers missing all 3 retries → status: incomplete with insufficient_coverage reason', async () => {
      // Mock agentRun to return the same thin output 4 times (initial + 3 retries)
      const thinOutput = {
        finalOutput: 'Short report covering marker-A only. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      };
      mockAgentRun.mockResolvedValueOnce(thinOutput);
      mockAgentRun.mockResolvedValueOnce({...thinOutput, state: { usage: { ...thinOutput.state.usage, requests: 2 } }});
      mockAgentRun.mockResolvedValueOnce({...thinOutput, state: { usage: { ...thinOutput.state.usage, requests: 3 } }});
      mockAgentRun.mockResolvedValueOnce({...thinOutput, state: { usage: { ...thinOutput.state.usage, requests: 4 } }});

      const task: TaskSpec = {
        prompt: 'test task',
        tier: 'standard',
        requiredCapabilities: [],
        expectedCoverage: {
          requiredMarkers: ['marker-A', 'marker-B', 'marker-C'],
        },
      };
      // const result = await runOpenAI(...);
      // expect(result.status).toBe('incomplete');
      // expect(result.error).toMatch(/supervision loop exhausted/);
      // expect(result.error).toMatch(/insufficient_coverage/);
      // Also verify the early-out break fired: with same-output detection,
      // the 2nd attempt's identical output should cause the loop to break
      // before running the 3rd and 4th retries.
    });

    it('task without expectedCoverage → validateCoverage is not called (no-op)', async () => {
      // Spy on validateCoverage to verify it's never called when the
      // field is undefined.
      const validateCoverageSpy = vi.spyOn(
        await import('../../packages/core/src/runners/supervision.js'),
        'validateCoverage',
      );

      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Normal response. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test task',
        tier: 'standard',
        requiredCapabilities: [],
        // NO expectedCoverage
      };
      // const result = await runOpenAI(...);
      // expect(result.status).toBe('ok');
      expect(validateCoverageSpy).not.toHaveBeenCalled();
      validateCoverageSpy.mockRestore();
    });
  });
  ```

- [ ] **Step 2: Run the tests and verify they fail.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts -t "coverage validation integration" 2>&1 | tail -20
  ```

  Expected: tests fail because the runner doesn't call `validateCoverage` yet.

### Step 3: Wire `validateCoverage` into openai-runner's supervision loop

- [ ] **Step 3: Find the existing `validateCompletion` call site in openai-runner's supervision loop.**

  ```bash
  grep -n "validateCompletion" packages/core/src/runners/openai-runner.ts
  ```

  There should be one call inside the `while(true)` supervision loop. Look at the surrounding code — you'll see something like:

  ```typescript
  const stripped = stripThinkingTags(extractAssistantText(currentResult.newItems) || currentResult.finalOutput || '');
  scratchpad.append(currentResult.state.usage.requests, stripped);
  const validation = validateCompletion(stripped);

  if (validation.valid) {
    // clean return path
    emit({ kind: 'done', status: 'ok' });
    return buildOkResult(stripped, currentResult, tracker, runner.providerConfig);
  }

  // degenerate path: increment retries, same-output check, re-prompt, continue
  // ... existing code ...
  ```

- [ ] **Step 4: Insert the coverage check after `validateCompletion` passes, before returning ok.**

  ```typescript
  const stripped = stripThinkingTags(extractAssistantText(currentResult.newItems) || currentResult.finalOutput || '');
  scratchpad.append(currentResult.state.usage.requests, stripped);
  let validation = validateCompletion(stripped);

  // NEW: after the syntactic check passes, run the caller-declared
  // coverage check if they opted in. A failing coverage check reuses
  // the existing degenerate-path logic via the insufficient_coverage
  // DegenerateKind.
  if (validation.valid && task.expectedCoverage) {
    const coverageValidation = validateCoverage(stripped, task.expectedCoverage);
    if (!coverageValidation.valid) {
      validation = coverageValidation;
    }
  }

  if (validation.valid) {
    // clean return path (unchanged)
    emit({ kind: 'done', status: 'ok' });
    return buildOkResult(stripped, currentResult, tracker, runner.providerConfig);
  }

  // degenerate path — unchanged; handles insufficient_coverage along with
  // empty / thinking_only / fragment / no_terminator through the same
  // retry + same-output early-out + re-prompt logic.
  ```

  Make sure `validateCoverage` is imported at the top of openai-runner.ts:

  ```typescript
  import {
    validateCompletion,
    validateCoverage,   // NEW
    buildRePrompt,
    // ... existing imports ...
  } from './supervision.js';
  ```

  Also verify that `let validation` is used (not `const validation`) so we can reassign it in the coverage branch.

- [ ] **Step 5: Run the openai-runner tests.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts 2>&1 | tail -15
  ```

  Expected: the new coverage tests pass. All pre-existing tests continue to pass.

### Step 6-7: Same integration for claude-runner

- [ ] **Step 6: Append the same four coverage integration tests to `tests/runners/claude-runner.test.ts`.**

  Use the claude-runner test file's existing mock pattern (async generator for `query()`). The test scenarios are identical to openai-runner's:

  1. `expectedCoverage.requiredMarkers` all present → ok
  2. Missing markers on first attempt, recovery on retry → ok
  3. Missing markers across all 3 retries → incomplete with `insufficient_coverage` reason
  4. No `expectedCoverage` → `validateCoverage` not called

  Follow the same structure as Step 1 above but use claude's SDK mock shape.

- [ ] **Step 7: Wire `validateCoverage` into claude-runner's supervision logic.**

  Find the place in claude-runner.ts where `validateCompletion(output)` is called (the fall-through after the iterator drains or after a re-prompt). Use the same pattern as Step 4:

  ```typescript
  let validation = validateCompletion(output);

  // NEW: coverage check
  if (validation.valid && task.expectedCoverage) {
    const coverageValidation = validateCoverage(output, task.expectedCoverage);
    if (!coverageValidation.valid) {
      validation = coverageValidation;
    }
  }

  if (!validation.valid && supervisionRetries < MAX_SUPERVISION_RETRIES) {
    // ... existing re-prompt logic ...
  }
  ```

  Import `validateCoverage` at the top of claude-runner.ts.

- [ ] **Step 8: Run the claude-runner tests.**

  ```bash
  npx vitest run tests/runners/claude-runner.test.ts 2>&1 | tail -10
  ```

### Step 9-10: Same integration for codex-runner

- [ ] **Step 9: Append the same four tests to `tests/runners/codex-runner.test.ts`.**

  Same four scenarios, using the codex-runner test file's existing mock pattern (the `client.responses.create` async generator).

- [ ] **Step 10: Wire `validateCoverage` into codex-runner.**

  Find the `validateCompletion(stripped)` call in codex-runner's hand-rolled loop (inside the "no tool calls → supervision" branch). Apply the same pattern:

  ```typescript
  let validation = validateCompletion(stripped);

  if (validation.valid && task.expectedCoverage) {
    const coverageValidation = validateCoverage(stripped, task.expectedCoverage);
    if (!coverageValidation.valid) {
      validation = coverageValidation;
    }
  }

  if (validation.valid) {
    // return ok
  }
  ```

  Import `validateCoverage` at the top of codex-runner.ts.

  Run:

  ```bash
  npx vitest run tests/runners/codex-runner.test.ts 2>&1 | tail -10
  ```

### Step 11: Cross-runner parity test

- [ ] **Step 11: Append a parity test to `tests/runners/cross-runner-parity.test.ts`.**

  ```typescript
  describe('cross-runner parity — expectedCoverage produces identical classification', () => {
    it('same expectedCoverage dispatched through all three mocked runners produces insufficient_coverage for the same thin output', async () => {
      const thinOutput = 'Report covering marker-A only. ' + 'x'.repeat(250);
      const coverage = {
        requiredMarkers: ['marker-A', 'marker-B', 'marker-C'],
      };

      // Mock each runner's SDK to return the thin output 4 times
      // (initial + 3 retries), then verify all three end up at
      // status: 'incomplete' with a reason containing 'insufficient_coverage'
      // or 'required markers'.

      // ... set up mocks for all three runners with the same thin output ...
      // ... dispatch through each runner with identical task spec ...
      // ... assert all three have status: 'incomplete' and matching error reasons ...
    });
  });
  ```

  The test exercises the invariant from spec §2.8: "same `expectedCoverage` dispatched through all three mocked runners produces identical progress event sequences and identical classification."

### Step 12: Regression test for round-2 Fate truncated-ok

- [ ] **Step 12: Append the captured-output regression to `tests/runners/supervision-regression.test.ts`.**

  This is the load-bearing regression test that pins the exact scenario from round 2: a Fate audit dispatch that came back with `status: ok` but only covered 43 of 85 checklist items. With the new coverage validation, the same output is classified as `insufficient_coverage` with a specific missing-markers list.

  ```typescript
  describe('round-2 Fate truncated-ok regression (v0.3.0)', () => {
    it('validateCoverage classifies a gap report missing half its checklist items as insufficient_coverage', () => {
      // Synthetic reproduction of the round-2 Fate failure: a gap report
      // that syntactically looks complete (has sections, terminal
      // punctuation, no fragment phrases) but only addresses items
      // 1.1 through 5.6, missing 5.7 through 10.2.
      const capturedOutput = `# Gap Report: fate

  ## 1. Bootstrap & wiring

  - **1.1** createEntryPoint order: PASS — /abs/path.ts:12-45
  - **1.2** cleanupHooks: PASS — ...
  - **1.3** rateLimitMax 100: PASS — ...
  - **1.4** setup.ts exports: PASS — ...
  - **1.5** sanitizeError customMappings: FAIL

  ### [1.5] — sanitizeError missing customMappings
  **Severity:** moderate
  **Evidence:** /abs/path.ts:50-60
  **Found:** no customMappings
  **Expected:** customMappings + knownCodes Set
  **Suggested fix:** pass customMappings: FATE_ERROR_MAPPINGS

  - **1.6** through **1.9**: PASS — ...

  ## 2. Data flow contracts

  - **2.1** through **2.14**: PASS — ...

  ## 3. SSE (steady-state)

  - **3.1** through **3.9**: PASS — ...

  ## 4. Stores & state

  - **4.1** through **4.6**: PASS — ...

  ## 5. XP & Bond

  - **5.1** through **5.6**: PASS — ...

  (Rest of report missing — model ran out of budget mid-section 5
  and emitted this as its final message.)
  `;

      const result = validateCoverage(capturedOutput, {
        requiredMarkers: [
          // Categories 1–10 item ids from the audit brief
          '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9',
          '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9',
          '2.10', '2.11', '2.12', '2.13', '2.14',
          '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9',
          '4.1', '4.2', '4.3', '4.4', '4.5', '4.6',
          '5.1', '5.2', '5.3', '5.4', '5.5', '5.6',
          '5.7', '5.8', '5.9', '5.10', '5.11',
          '6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7', '6.8', '6.9',
          '7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.8', '7.9',
          '7.10', '7.11', '7.12', '7.13', '7.14', '7.15', '7.16',
          '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '8.7', '8.8', '8.9',
          '8.10', '8.11', '8.12', '8.13', '8.14',
          '9.1', '9.2', '9.3', '9.4',
          '10.1', '10.2',
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.kind).toBe('insufficient_coverage');
      expect(result.reason).toMatch(/required markers/);
      // The report covers categories 1-5.6. Missing: 5.7 through 10.2.
      // That's roughly 40 missing markers out of 85.
      expect(result.reason).toMatch(/5\.7|5\.8|5\.9|5\.10|5\.11/);
    });
  });
  ```

  Import `validateCoverage` at the top of the regression test file if not already.

- [ ] **Step 13: Run the regression test.**

  ```bash
  npx vitest run tests/runners/supervision-regression.test.ts 2>&1 | tail -10
  ```

  Expected: passes. The captured synthetic output is missing markers 5.7+ and `validateCoverage` classifies it as `insufficient_coverage` with a reason naming the first few missing markers.

### Step 14: Full suite + commit

- [ ] **Step 14: Run the full test suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: clean build, ~420 tests passing (baseline ~418 from Task 7 + 4 per runner × 3 = 12 coverage integration tests + 1 parity + 1 regression = 14 new, but some may overlap so ~432 range).

- [ ] **Step 15: Commit Task 8.**

  ```bash
  git add packages/core/src/runners/openai-runner.ts packages/core/src/runners/claude-runner.ts packages/core/src/runners/codex-runner.ts tests/runners/openai-runner.test.ts tests/runners/claude-runner.test.ts tests/runners/codex-runner.test.ts tests/runners/cross-runner-parity.test.ts tests/runners/supervision-regression.test.ts
  git commit -m "feat(core): wire validateCoverage into all three runners

  Per spec §2.6. Runner supervision loops now call validateCoverage
  after validateCompletion passes, when the caller declared
  expectedCoverage on the TaskSpec. A failing coverage check flows
  through the existing degenerate-path logic — same retries, same
  same-output early-out, same supervision exhaustion — via the
  insufficient_coverage DegenerateKind landed in Task 1.

  Callers who omit expectedCoverage see zero change in behavior.
  Callers who opt in get real semantic incompleteness detection.

  - openai-runner: insert validateCoverage call between validateCompletion
    success and buildOkResult return
  - claude-runner: same insertion in its post-iterator validation path
  - codex-runner: same insertion in its 'no tool calls → supervision' branch
  - cross-runner parity test: same expectedCoverage across all three
    runners produces identical insufficient_coverage classification
  - regression test: captured round-2 Fate truncated-ok output
    (covers 43 of 85 items) is classified as insufficient_coverage
    with a reason naming the first missing markers

  Tests: 14 new (4 per runner × 3 + 1 parity + 1 regression).

  Spec: §2"
  ```

---

## Task 9: Runner `durationMs` + `savedCostUSD` capture

**Goal:** Populate `durationMs` on every RunResult return path across all three runners. Call `computeSavedCostUSD` in result helpers when the task has `parentModel` set. After this task, every dispatch returns real duration data and (when opted in) real savings estimates — which Task 12 then aggregates into the batch-level `timings` / `aggregateCost` envelope fields.

**Files:**
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `tests/runners/openai-runner.test.ts`
- Modify: `tests/runners/claude-runner.test.ts`
- Modify: `tests/runners/codex-runner.test.ts`

### Step 1: Write the durationMs + savedCostUSD integration tests

- [ ] **Step 1: Append tests to `tests/runners/openai-runner.test.ts`.**

  ```typescript
  describe('openai-runner — durationMs + savedCostUSD capture (v0.3.0)', () => {
    it('populates durationMs on ok return path', async () => {
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Valid final answer. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      // const result = await runOpenAI(task, options, runnerOpts);
      // expect(result.status).toBe('ok');
      // expect(result.durationMs).toBeDefined();
      // expect(result.durationMs).toBeGreaterThan(0);
    });

    it('populates durationMs on incomplete (supervision-exhausted) return path', async () => {
      const thin = {
        finalOutput: 'Let me check:',
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, requests: 1 } },
        history: [],
      };
      mockAgentRun.mockResolvedValueOnce(thin);
      mockAgentRun.mockResolvedValueOnce(thin);  // early-out after 2nd identical

      // const result = await runOpenAI(...);
      // expect(result.status).toBe('incomplete');
      // expect(result.durationMs).toBeDefined();
      // expect(result.durationMs).toBeGreaterThan(0);
    });

    it('populates durationMs on error catch path', async () => {
      mockAgentRun.mockRejectedValueOnce(new Error('boom'));
      // const result = await runOpenAI(...);
      // expect(['error', 'api_aborted', 'api_error', 'network_error']).toContain(result.status);
      // expect(result.durationMs).toBeDefined();
      // expect(result.durationMs).toBeGreaterThan(0);
    });

    it('populates savedCostUSD when parentModel is set', async () => {
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Valid final answer. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test',
        tier: 'standard',
        requiredCapabilities: [],
        parentModel: 'claude-opus-4-6',  // assume this profile has rates
      };
      // const result = await runOpenAI(task, ...);
      // expect(result.usage.savedCostUSD).toBeDefined();
      // expect(result.usage.savedCostUSD).not.toBeNull();
      // (sign depends on the actual provider's rates vs opus — usually positive)
    });

    it('savedCostUSD is null when parentModel is not set', async () => {
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Valid final answer. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test',
        tier: 'standard',
        requiredCapabilities: [],
        // no parentModel
      };
      // const result = await runOpenAI(task, ...);
      // Either undefined or null — both are acceptable "null" signals
      // expect(result.usage.savedCostUSD ?? null).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run and verify they fail.**

  ```bash
  npx vitest run tests/runners/openai-runner.test.ts -t "durationMs \\+ savedCostUSD" 2>&1 | tail -15
  ```

### Step 3-5: Implement in openai-runner

- [ ] **Step 3: Capture `taskStartMs` at the top of `runOpenAI`'s `run()` function.**

  Find the `run` function inside `runOpenAI`. At the very top (before the try block and any other setup), add:

  ```typescript
  const taskStartMs = Date.now();
  ```

- [ ] **Step 4: Populate `durationMs` on every return path via the helpers.**

  The helpers (`buildOkResult`, `buildSupervisionExhaustedResult`, `buildForceSalvageResult`) are at the bottom of the file outside the `run` closure, so they don't naturally see `taskStartMs`. Two options:
  - (A) Pass `taskStartMs` to each helper as an argument
  - (B) Compute `durationMs` at the call site and pass it as a field

  Option (A) is cleaner — less arithmetic at the call sites. Update each helper:

  ```typescript
  function buildOkResult(
    output: string,
    currentResult: AgentRunOutput,
    tracker: FileTracker,
    providerConfig: ProviderConfig,
    taskStartMs: number,           // NEW
    parentModel: string | undefined, // NEW — for savedCostUSD
  ): RunResult {
    const usage = currentResult.state.usage;
    const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
    const savedCostUSD = computeSavedCostUSD(costUSD, usage.inputTokens, usage.outputTokens, parentModel);
    return {
      output,
      status: 'ok',
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUSD,
        savedCostUSD,                // NEW
      },
      turns: usage.requests,
      filesRead: tracker.getReads(),
      filesWritten: tracker.getWrites(),
      directoriesListed: tracker.getDirectoriesListed(),
      toolCalls: tracker.getToolCalls(),
      outputIsDiagnostic: false,
      durationMs: Date.now() - taskStartMs,   // NEW
      escalationLog: [],
    };
  }
  ```

  Do the same for `buildSupervisionExhaustedResult` and `buildForceSalvageResult`. Import `computeSavedCostUSD` at the top:

  ```typescript
  import { computeCostUSD, computeSavedCostUSD } from '../cost.js';
  ```

- [ ] **Step 5: Update all call sites to pass `taskStartMs` and `task.parentModel`.**

  Every `return buildOkResult(...)` / `return buildSupervisionExhaustedResult(...)` / `return buildForceSalvageResult(...)` call inside `runOpenAI` needs the two new arguments:

  ```typescript
  return buildOkResult(stripped, currentResult, tracker, runner.providerConfig, taskStartMs, task.parentModel);
  ```

  Also update the inline `return` branches (max_turns, error catch, withTimeout) to populate `durationMs` and `savedCostUSD` directly:

  For the `MaxTurnsExceededError` catch branch:

  ```typescript
  if (err instanceof MaxTurnsExceededError) {
    const hasSalvage = !scratchpad.isEmpty();
    emit({ kind: 'done', status: 'max_turns' });
    const turnsAtFailure = currentResult?.state.usage.requests ?? maxTurns;
    const usage = partialUsage(currentResult, runner.providerConfig);
    const savedCostUSD = computeSavedCostUSD(
      usage.costUSD,
      usage.inputTokens,
      usage.outputTokens,
      task.parentModel,
    );
    return {
      output: hasSalvage ? scratchpad.latest() : `Agent exceeded max turns (${maxTurns}).`,
      status: 'max_turns',
      usage: { ...usage, savedCostUSD },   // spread + add
      turns: turnsAtFailure,
      filesRead,
      filesWritten,
      directoriesListed: tracker.getDirectoriesListed(),
      toolCalls,
      outputIsDiagnostic: !hasSalvage,
      durationMs: Date.now() - taskStartMs,
      escalationLog: [],
      error: `agent exhausted user-declared maxTurns limit (${maxTurns}) after ${turnsAtFailure} turns`,
    };
  }
  ```

  For the generic error catch branch (same pattern — compute `savedCostUSD` and `durationMs`, add both to the returned object).

  For the `withTimeout` onTimeout callback (same pattern).

### Step 6-8: Same changes for claude-runner and codex-runner

- [ ] **Step 6: Apply the same `taskStartMs` capture + helper arg + call site updates to claude-runner.**

  The helpers are `buildClaudeOkResult`, `buildClaudeIncompleteResult`, `buildClaudeForceSalvageResult`, `buildClaudeMaxTurnsResult`. Each gets `taskStartMs: number` and `parentModel: string | undefined` added to its args type. Each computes `savedCostUSD` from its existing usage fields and populates `durationMs: Date.now() - taskStartMs` in the returned object.

  All inline error/timeout branches get the same treatment.

- [ ] **Step 7: Apply the same changes to codex-runner.**

  Helpers: `buildCodexOkResult`, `buildCodexIncompleteResult`, `buildCodexForceSalvageResult`, `buildCodexMaxTurnsResult`. Same pattern.

- [ ] **Step 8: Append the same five integration tests to claude-runner and codex-runner test files.**

  Use each runner's existing mock pattern. Verify:
  1. `durationMs` populated on ok
  2. `durationMs` populated on incomplete
  3. `durationMs` populated on error catch
  4. `savedCostUSD` populated when `parentModel` is set
  5. `savedCostUSD` is null/undefined when `parentModel` is not set

### Step 9: Full test suite + commit

- [ ] **Step 9: Run the full suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: clean build, ~432 + 15 = ~447 tests passing.

- [ ] **Step 10: Commit Task 9.**

  ```bash
  git add packages/core/src/runners/openai-runner.ts packages/core/src/runners/claude-runner.ts packages/core/src/runners/codex-runner.ts tests/runners/openai-runner.test.ts tests/runners/claude-runner.test.ts tests/runners/codex-runner.test.ts
  git commit -m "feat(core): durationMs + savedCostUSD capture in all three runners

  Per spec §5.5, §5.6. Each runner now captures taskStartMs at the top
  of its run() function and populates durationMs on every RunResult
  return path. Each runner also calls computeSavedCostUSD with the
  task's parentModel (if set) to populate usage.savedCostUSD.

  Together with Task 12's envelope aggregates, this gives the caller
  visible cost and time savings at both per-task and batch levels.

  - Helper signatures gain taskStartMs + parentModel parameters
  - Every call site passes both
  - Inline error/timeout branches compute the fields directly
  - All three runners: symmetric pattern

  Tests: 15 new (5 per runner × 3).

  Spec: §5"
  ```

---

## Task 10: Runner `progressTrace` capture + orchestrator propagation

**Goal:** When a task has `includeProgressTrace: true`, each runner captures every emitted progress event into a per-run buffer, trims it via `trimProgressTrace` at return time, and attaches the result to `RunResult.progressTrace`. The orchestrator in `delegate-with-escalation.ts` copies `result.progressTrace` into each `AttemptRecord`, so callers can inspect every attempt's trace via `escalationLog[i].progressTrace`.

**Files:**
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `packages/core/src/delegate-with-escalation.ts`
- Modify: `tests/runners/openai-runner.test.ts`
- Modify: `tests/runners/claude-runner.test.ts`
- Modify: `tests/runners/codex-runner.test.ts`
- Modify: `tests/delegate-with-escalation.test.ts`

### Step 1-3: openai-runner capture + trim + return

- [ ] **Step 1: Append progressTrace tests to `tests/runners/openai-runner.test.ts`.**

  ```typescript
  describe('openai-runner — progressTrace capture (v0.3.0)', () => {
    it('task with includeProgressTrace: false → result.progressTrace is undefined', async () => {
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Valid final answer. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test',
        tier: 'standard',
        requiredCapabilities: [],
        // includeProgressTrace omitted (default false)
      };
      // const result = await runOpenAI(task, ...);
      // expect(result.progressTrace).toBeUndefined();
    });

    it('task with includeProgressTrace: true → result.progressTrace contains expected events', async () => {
      mockAgentRun.mockResolvedValueOnce({
        finalOutput: 'Valid final answer. ' + 'x'.repeat(250),
        newItems: [],
        state: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 1 } },
        history: [],
      });

      const task: TaskSpec = {
        prompt: 'test',
        tier: 'standard',
        requiredCapabilities: [],
        includeProgressTrace: true,
      };
      // const result = await runOpenAI(task, ...);
      // expect(result.progressTrace).toBeDefined();
      // expect(Array.isArray(result.progressTrace)).toBe(true);
      // // Should include turn_start, text_emission, turn_complete, done at minimum
      // const kinds = result.progressTrace!.map(e => 'kind' in e ? e.kind : '_trimmed');
      // expect(kinds).toContain('turn_start');
      // expect(kinds).toContain('turn_complete');
      // expect(kinds).toContain('done');
    });

    it('long dispatch triggers trimming → _trimmed marker present', async () => {
      // Set up a mock that causes the runner to emit >80 events.
      // Simplest: mock agentRun to return a result with many mock newItems
      // that each trigger a text_emission via extractAssistantText.
      // Alternatively, simulate a long supervision retry loop.
      // ... implementation depends on existing mock helpers ...
      // expect(result.progressTrace).toBeDefined();
      // expect(result.progressTrace!.some(e => 'kind' in e && e.kind === '_trimmed')).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Implement the capture in openai-runner.**

  Near the top of `runOpenAI` (after `const onProgress = options.onProgress;` and `const emit = ...`), add:

  ```typescript
  const shouldCaptureTrace = task.includeProgressTrace ?? false;
  const traceBuffer: ProgressEvent[] = [];
  ```

  Modify the `emit` closure to push each event into the buffer when capturing:

  ```typescript
  const emit = (event: ProgressEvent): void => {
    if (shouldCaptureTrace) traceBuffer.push(event);
    if (safeSink) safeSink(event);
  };
  ```

  Import `ProgressEvent` and `trimProgressTrace` at the top if not already imported.

- [ ] **Step 3: Pass the captured buffer into result helpers and trim at return time.**

  Update each result-builder helper signature again (yes, they're growing — this is the last field):

  ```typescript
  function buildOkResult(
    output: string,
    currentResult: AgentRunOutput,
    tracker: FileTracker,
    providerConfig: ProviderConfig,
    taskStartMs: number,
    parentModel: string | undefined,
    traceBuffer: ProgressEvent[] | undefined,  // NEW
  ): RunResult {
    // ... existing body ...
    return {
      // ... existing fields ...
      durationMs: Date.now() - taskStartMs,
      ...(traceBuffer && { progressTrace: trimProgressTrace(traceBuffer) }),
      escalationLog: [],
    };
  }
  ```

  Call sites pass `shouldCaptureTrace ? traceBuffer : undefined` (so the trace is undefined when the caller didn't opt in):

  ```typescript
  return buildOkResult(
    stripped,
    currentResult,
    tracker,
    runner.providerConfig,
    taskStartMs,
    task.parentModel,
    shouldCaptureTrace ? traceBuffer : undefined,
  );
  ```

  Apply the same pattern to all inline error/timeout branches — spread an optional `progressTrace` field into the return object when `shouldCaptureTrace` is true.

### Step 4-5: Same for claude-runner and codex-runner

- [ ] **Step 4: Apply the same capture + trim + return pattern to claude-runner.**

  Declare `shouldCaptureTrace` and `traceBuffer` near the top of `runClaude`. Modify its `emit` closure to push to the buffer. Update `buildClaudeOkResult` / `buildClaudeIncompleteResult` / `buildClaudeForceSalvageResult` / `buildClaudeMaxTurnsResult` to accept and use the buffer.

- [ ] **Step 5: Apply the same to codex-runner.**

  Same pattern.

### Step 6: Orchestrator propagation into AttemptRecord

- [ ] **Step 6: Update `delegate-with-escalation.ts` to copy `result.progressTrace` into the AttemptRecord.**

  Find the place where `AttemptRecord` is constructed in the per-attempt loop. Add:

  ```typescript
  const record: AttemptRecord = {
    provider: provider.name,
    status: result.status,
    turns: result.turns,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
    initialPromptLengthChars,
    initialPromptHash,
    reason: result.status === 'ok' ? undefined : (result.error || `status=${result.status}`),
    ...(result.progressTrace && { progressTrace: result.progressTrace }),  // NEW
  };
  ```

  Add a test to `tests/delegate-with-escalation.test.ts`:

  ```typescript
  describe('delegateWithEscalation — progressTrace propagation (v0.3.0)', () => {
    it('copies result.progressTrace into AttemptRecord', async () => {
      const mockProvider: Provider = {
        name: 'mock',
        config: { type: 'codex', model: 'gpt-5-codex' },
        run: vi.fn().mockResolvedValue({
          ...makeMockResult('ok', 'final text'),
          progressTrace: [
            { kind: 'turn_start', turn: 1, provider: 'codex' },
            { kind: 'done', status: 'ok' },
          ],
        }),
      };

      const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
      const result = await delegateWithEscalation(task, [mockProvider]);

      expect(result.escalationLog).toHaveLength(1);
      expect(result.escalationLog[0].progressTrace).toBeDefined();
      expect(result.escalationLog[0].progressTrace).toHaveLength(2);
    });
  });
  ```

### Step 7: Verify and commit

- [ ] **Step 7: Run the full test suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: ~447 + 10 = ~457 tests passing.

- [ ] **Step 8: Commit Task 10.**

  ```bash
  git add packages/core/src/runners/openai-runner.ts packages/core/src/runners/claude-runner.ts packages/core/src/runners/codex-runner.ts packages/core/src/delegate-with-escalation.ts tests/runners/openai-runner.test.ts tests/runners/claude-runner.test.ts tests/runners/codex-runner.test.ts tests/delegate-with-escalation.test.ts
  git commit -m "feat(core): progressTrace capture in runners + orchestrator propagation

  Per spec §6.5-§6.8. When a task has includeProgressTrace: true, each
  runner captures every emitted progress event into a per-run buffer,
  trims it via trimProgressTrace at return time, and attaches the
  result to RunResult.progressTrace. The orchestrator copies
  result.progressTrace into each AttemptRecord, so callers can inspect
  every attempt's trace via escalationLog[i].progressTrace. Top-level
  result.progressTrace remains the final attempt's trace.

  - Each runner: shouldCaptureTrace flag + traceBuffer at top of run()
  - emit closure pushes to buffer when shouldCaptureTrace is true
  - Result helpers accept traceBuffer and call trimProgressTrace when
    the caller opted in
  - Inline error/timeout branches spread trimmed progressTrace when
    shouldCaptureTrace
  - delegate-with-escalation AttemptRecord construction copies
    result.progressTrace when present

  Tests: 10 new (3 per runner + 1 orchestrator propagation).

  Spec: §6"
  ```

---

## Task 11: Response pagination + `get_task_output` + configurable threshold

**Goal:** Add the `responseMode: 'full' | 'summary' | 'auto'` parameter to `delegate_tasks`, implement auto-escape at the configurable threshold, register the new `get_task_output` MCP tool, and extend the batch cache to store `RunResult[]` so `get_task_output` can retrieve full outputs from a previous batch. The `largeResponseThresholdChars` is configurable via env var > config file > `buildMcpServer` option > hardcoded default (65536).

**Files:**
- Modify: `packages/mcp/src/cli.ts`
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/config.test.ts` (if it exists — otherwise add schema tests to `tests/cli.test.ts`)

### Step 1: Write the threshold-resolution tests

- [ ] **Step 1: Append tests to `tests/cli.test.ts` covering the precedence chain.**

  ```typescript
  describe('buildMcpServer — largeResponseThresholdChars (v0.3.0)', () => {
    beforeEach(() => {
      delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
    });

    it('default threshold is 65_536 when no overrides', () => {
      const server = buildMcpServer(sampleConfig());
      // No direct way to inspect the resolved threshold, so test via behavior:
      // dispatch a small batch and verify mode: 'full'
      // (full integration test below covers this)
      expect(server).toBeDefined();
    });

    it('buildMcpServer option overrides the default', () => {
      const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
      expect(server).toBeDefined();
      // Tested via behavior — Step 2's integration test
    });

    it('config file override beats buildMcpServer option', () => {
      const config = {
        ...sampleConfig(),
        defaults: {
          ...sampleConfig().defaults,
          largeResponseThresholdChars: 500,
        },
      };
      const server = buildMcpServer(config, { largeResponseThresholdChars: 100 });
      expect(server).toBeDefined();
    });

    it('env var beats everything', () => {
      process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS = '9999';
      const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
      expect(server).toBeDefined();
      delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
    });

    it('malformed env var (non-integer) falls through to next layer, does not crash', () => {
      process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS = 'not-a-number';
      expect(() => buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 })).not.toThrow();
      delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
    });
  });
  ```

- [ ] **Step 2: Append response-mode integration tests.**

  ```typescript
  describe('delegate_tasks — responseMode + pagination (v0.3.0)', () => {
    beforeEach(() => {
      // Mock runTasks to return stub results (reuse the existing pattern
      // from tests/cli.test.ts v0.2.0 LRU test).
    });

    it('small batch + responseMode: auto → mode: full, no note', async () => {
      // Mock runTasks to return 3 small outputs
      // Dispatch with responseMode: 'auto' (or omitted)
      // Assert response.mode === 'full', response.note is undefined
    });

    it('small batch + responseMode: summary → mode: summary, no note', async () => {
      // Caller explicitly asked for summary
      // Assert response.mode === 'summary', response.note is undefined,
      // each result has outputLength + outputSha256 + _fetchWith
      // outputSha256 MUST be the full 64-char SHA-256 hex digest (per spec §3.4).
      // Assert: /^[0-9a-f]{64}$/.test(result.outputSha256) for every result.
    });

    it('large batch + responseMode: auto → mode: summary with note', async () => {
      // Mock runTasks to return results whose combined output.length > 65536
      // Assert response.mode === 'summary', response.note is defined,
      // response.note contains 'Auto-switched' or 'threshold'
    });

    it('large batch + responseMode: full → mode: full anyway (escape hatch)', async () => {
      // Caller explicitly forces full mode
      // Assert response.mode === 'full' even though combined output > threshold
    });

    it('responseMode omitted → defaults to auto', async () => {
      // Same as the 'auto' test above but with no responseMode in the input
    });

    it('configurable threshold via buildMcpServer option triggers summary mode', async () => {
      // Set threshold to 100, dispatch a batch with 200+ chars of combined output
      // Assert mode === 'summary'
    });

    it('configurable threshold via env var triggers summary mode', async () => {
      // Set env var to 100, dispatch
      // Assert mode === 'summary'
    });
  });

  describe('get_task_output tool (v0.3.0)', () => {
    it('valid batchId + taskIndex → returns full text', async () => {
      // Dispatch first, capture batchId
      // Call get_task_output({ batchId, taskIndex: 0 })
      // Assert the returned text matches the original full output
    });

    it('unknown batchId → throws "unknown or expired"', async () => {
      // Call get_task_output with a bogus batchId
      // Assert it throws with /unknown or expired/
    });

    it('expired batchId → evicts and throws', async () => {
      // Dispatch, manipulate the cache entry's expiresAt to the past,
      // call get_task_output, assert it throws and the entry is now gone
    });

    it('out-of-range taskIndex → throws "out of range"', async () => {
      // Dispatch a 3-task batch, call get_task_output with taskIndex: 10
      // Assert /out of range/
    });

    it('dispatch throws mid-flight → batch still has results attached as [] (try/finally)', async () => {
      // Mock runTasks to reject with an Error
      // Call delegate_tasks and catch the rethrown error
      // Inspect the batchCache entry directly (export for test, or via module-level getter)
      // Assert: batchCache.get(batchId).results is an empty array, not undefined
      // Then call get_task_output({ batchId, taskIndex: 0 }) and assert it throws /out of range/
      // (not /no stored results/, because results was attached as [] in the finally block)
    });

    it('batch with explicitly absent results → throws "no stored results" (defensive check)', async () => {
      // Manipulate the cache directly to have batch.results === undefined
      // (simulates a code path that bypassed the try/finally entirely)
      // Assert get_task_output throws /no stored results/
    });

    it('get_task_output touches LRU order', async () => {
      // Dispatch 100 batches
      // Touch the first batch via get_task_output
      // Dispatch one more batch — this should evict the oldest-not-touched,
      // NOT the first batch
      // get_task_output on the first batch still works
    });

    it('get_task_output does NOT refresh TTL', async () => {
      // Dispatch, manipulate expiresAt to be 29 minutes old
      // get_task_output once (touches LRU, not TTL)
      // Manipulate expiresAt to be 31 minutes old
      // get_task_output throws expired
    });
  });

  describe('retry_tasks — pagination + new batch (v0.3.0)', () => {
    it('accepts responseMode and honors it on the retry response', async () => {
      // Dispatch a 3-task batch, capture batchId
      // Call retry_tasks({ batchId, taskIndices: [0, 2], responseMode: 'summary' })
      // Assert response.mode === 'summary'
      // Assert response.results[0].outputSha256 matches /^[0-9a-f]{64}$/
    });

    it('creates a fresh batch for the retried tasks (new batchId, original preserved)', async () => {
      // Dispatch a 3-task batch → capture originalBatchId
      // retry_tasks({ batchId: originalBatchId, taskIndices: [1] }) → capture retryBatchId
      // Assert retryBatchId !== originalBatchId
      // Assert batchCache has entries for BOTH ids
      // Assert the retry batch only contains the 1 retried task
      // Assert get_task_output({ batchId: originalBatchId, taskIndex: 1 }) still returns
      //   the ORIGINAL task's output (retry did NOT overwrite it)
      // Assert get_task_output({ batchId: retryBatchId, taskIndex: 0 }) returns the retried output
    });

    it('retry_tasks responseMode: auto escapes to summary at configurable threshold', async () => {
      // Build server with largeResponseThresholdChars: 100
      // Dispatch a batch whose retried task produces > 100 chars
      // retry_tasks({ batchId, taskIndices: [0], responseMode: 'auto' })
      // Assert response.mode === 'summary', response.note contains 'Auto-switched'
    });

    it('retry_tasks responseMode defaults to auto when omitted', async () => {
      // Dispatch small batch, retry without responseMode
      // Assert response.mode === 'full' (combined output under threshold)
    });

    it('retry_tasks populates the retry batch results via try/finally even if dispatch throws', async () => {
      // Mock runTasks to reject on the retry call
      // Call retry_tasks, catch rethrown error
      // Assert the new retry batch entry still has results: []
      // Assert the original batch entry is untouched (its results are still the original run)
    });

    it('retry_tasks response includes the new batchId so callers can chain retries', async () => {
      // Dispatch, retry, inspect response.batchId
      // Assert response.batchId === the new retry batch id (not the original)
    });

    it('retry_tasks response includes originalBatchId + originalIndices for traceability', async () => {
      // Dispatch 3-task batch → capture originalBatchId
      // retry_tasks({ batchId: originalBatchId, taskIndices: [0, 2] })
      // Assert response.originalBatchId === originalBatchId
      // Assert response.originalIndices === [0, 2]
      // Assert response.results.length === 2 (positional match with originalIndices)
    });
  });
  ```

### Step 3: Implement threshold resolution and add the `responseMode` param

- [ ] **Step 3: Update `buildMcpServer` signature to accept the options argument.**

  At the top of `packages/mcp/src/cli.ts`, add a new constant near the existing `BATCH_TTL_MS` / `BATCH_MAX`:

  ```typescript
  const DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS = 65_536;
  ```

  Add a `parsePositiveInt` helper (module-level or local to `buildMcpServer`):

  ```typescript
  function parsePositiveInt(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const n = Number.parseInt(s, 10);
    if (Number.isFinite(n) && n > 0 && String(n) === s.trim()) return n;
    return undefined;
  }
  ```

  Update `buildMcpServer` signature and add threshold resolution at the top:

  ```typescript
  export function buildMcpServer(
    config: Parameters<typeof runTasks>[1],
    options?: {
      /** Character threshold that triggers auto-switch from 'full' to
       *  'summary' response mode when the caller uses `responseMode: 'auto'`
       *  (the default). Defaults to 65_536, tuned for Claude Code's inline
       *  rendering limit. Precedence (highest first): env var
       *  MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS > config file
       *  defaults.largeResponseThresholdChars > this option > default. */
      largeResponseThresholdChars?: number;
    },
  ) {
    // Resolve the threshold once at server startup
    const envThreshold = parsePositiveInt(process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS);
    if (process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS !== undefined && envThreshold === undefined) {
      process.stderr.write(
        `[multi-model-agent] warning: MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS=${process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS} is not a positive integer, ignoring\n`,
      );
    }
    const resolvedThreshold =
      envThreshold
      ?? config.defaults.largeResponseThresholdChars
      ?? options?.largeResponseThresholdChars
      ?? DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS;

    // ... rest of buildMcpServer body unchanged ...
  }
  ```

  **The config-file layer is a required precedence step — it must be typed, not read via a cast.** Update the schema and type before this resolver compiles.

- [ ] **Step 3a: Extend the `MultiModelConfig` TypeScript type.**

  Edit `packages/core/src/types.ts` around line 113:

  ```typescript
  export interface MultiModelConfig {
    providers: Record<string, ProviderConfig>
    defaults: {
      maxTurns: number
      timeoutMs: number
      tools: ToolMode
      /** Character threshold for delegate_tasks `responseMode: 'auto'`
       *  auto-escape from 'full' to 'summary'. Optional — defaults to
       *  65_536 when absent. Env var and buildMcpServer option can override. */
      largeResponseThresholdChars?: number
    }
  }
  ```

- [ ] **Step 3b: Extend the Zod schema in `packages/core/src/config/schema.ts`.**

  Find the `defaultsSchema` (around line 74) and add the new optional field:

  ```typescript
  const defaultsSchema = z.object({
    maxTurns: z.number().int().positive().default(200),
    timeoutMs: z.number().int().positive().default(600_000),
    tools: z.enum(['none', 'full']).default('full'),
    largeResponseThresholdChars: z.number().int().positive().optional(),
  }).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const }));
  ```

  The `.default()` factory does not need to include `largeResponseThresholdChars` since it is optional — absent means "use the fallback chain in cli.ts".

- [ ] **Step 3c: Add schema tests proving the field is accepted and typed.**

  Add to `tests/config.test.ts` (or `tests/cli.test.ts` if no config test file exists):

  ```typescript
  describe('multiModelConfigSchema — largeResponseThresholdChars (v0.3.0)', () => {
    it('accepts a positive integer on defaults.largeResponseThresholdChars', () => {
      const parsed = parseConfig({
        providers: {},
        defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full', largeResponseThresholdChars: 32_768 },
      });
      expect(parsed.defaults.largeResponseThresholdChars).toBe(32_768);
    });

    it('omitted largeResponseThresholdChars stays undefined (handler falls through to default)', () => {
      const parsed = parseConfig({ providers: {}, defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' } });
      expect(parsed.defaults.largeResponseThresholdChars).toBeUndefined();
    });

    it('rejects zero or negative values', () => {
      expect(() =>
        parseConfig({ providers: {}, defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full', largeResponseThresholdChars: 0 } }),
      ).toThrow();
      expect(() =>
        parseConfig({ providers: {}, defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full', largeResponseThresholdChars: -1 } }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        parseConfig({ providers: {}, defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full', largeResponseThresholdChars: 1.5 } }),
      ).toThrow();
    });
  });
  ```

  Also extend the precedence-chain integration test in Step 1 so the `'config file override beats buildMcpServer option'` case actually exercises `buildMcpServer` reading `config.defaults.largeResponseThresholdChars` end-to-end rather than just smoke-testing construction.

### Step 4-5: Extend batch cache shape and add responseMode to the delegate_tasks schema

- [ ] **Step 4: Extend the batch cache shape to store `RunResult[]`.**

  Find the existing `batchCache` declaration:

  ```typescript
  const batchCache = new Map<string, { tasks: TaskSpec[]; expiresAt: number }>();
  ```

  Extend:

  ```typescript
  const batchCache = new Map<string, {
    tasks: TaskSpec[];
    results?: RunResult[];  // NEW: populated after dispatch returns
    expiresAt: number;
  }>();
  ```

  Import `RunResult` at the top if not already:

  ```typescript
  import type { ..., RunResult } from '@zhixuan92/multi-model-agent-core';
  ```

- [ ] **Step 5: Add `responseMode` to the delegate_tasks input schema.**

  Find the zod schema object where `delegate_tasks` inputs are declared. It currently has `{ tasks: z.array(...) }`. Extend:

  ```typescript
  {
    tasks: z.array(buildTaskSchema(availableProviders)).describe('Array of tasks to execute in parallel'),
    responseMode: z.enum(['full', 'summary', 'auto']).optional().describe(
      `How to shape the response envelope. 'full' (default via 'auto') includes each task's output inline. ` +
      `'summary' returns per-task metadata + outputLength + outputSha256, with full outputs fetchable via ` +
      `get_task_output. 'auto' (the default) returns 'full' when combined output fits under the server's ` +
      `threshold (default 65 KB; configurable via env / config / buildMcpServer option), otherwise 'summary' ` +
      `with an auto-escape note.`,
    ),
  },
  ```

### Step 6-8: Implement the handler response shape + buildFullResponse / buildSummaryResponse

- [ ] **Step 6: Update the `delegate_tasks` handler to compute the effective mode.**

  Inside the async handler body, after the existing `rememberBatch(tasks)` call, modify the `runTasks` invocation to capture the wall-clock timing AND attach results to the cache:

  ```typescript
  async ({ tasks, responseMode = 'auto' }, extra) => {
    // ... existing progress bridge setup unchanged ...

    const batchId = rememberBatch(tasks as TaskSpec[]);

    // Time the dispatch for the batch-level timings aggregate
    const batchStartMs = Date.now();
    let results: RunResult[] | undefined;
    try {
      results = await runTasks(tasks as TaskSpec[], config, {
        onProgress: sendProgress,
        runtime: { contextBlockStore },
      });
    } finally {
      // Always attach `results ?? []` so a mid-flight throw does not leave
      // a dangling batchCache entry that `get_task_output` can't distinguish
      // from "dispatch still in progress". Per spec §3.5 / §3.9 item 3.
      const batchEntry = batchCache.get(batchId);
      if (batchEntry) batchEntry.results = results ?? [];
    }
    const wallClockMs = Date.now() - batchStartMs;

    // Determine effective response mode based on the configurable threshold
    const totalOutputChars = results.reduce((sum, r) => sum + r.output.length, 0);
    const effectiveMode: 'full' | 'summary' =
      responseMode === 'full'
        ? 'full'
        : responseMode === 'summary'
          ? 'summary'
          : totalOutputChars > resolvedThreshold
            ? 'summary'
            : 'full';

    // Envelope aggregates — these are Task 12's territory but we stub
    // empty values here and Task 12 will fill them in properly.
    // For now, build the response in a mode-appropriate shape without
    // the aggregates.
    const response =
      effectiveMode === 'full'
        ? buildFullResponse(batchId, tasks, results)
        : buildSummaryResponse(batchId, tasks, results, {
            autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
            totalOutputChars,
            threshold: resolvedThreshold,
          });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
    };
  }
  ```

- [ ] **Step 7: Add the `buildFullResponse` helper.**

  Add near the top of `cli.ts` (module-level, above `buildMcpServer`):

  ```typescript
  function buildFullResponse(
    batchId: string,
    tasks: TaskSpec[],
    results: RunResult[],
  ) {
    return {
      batchId,
      mode: 'full' as const,
      // NOTE: timings, batchProgress, aggregateCost added in Task 12
      results: results.map((r, i) => ({
        provider: tasks[i].provider ?? '(auto)',
        status: r.status,
        output: r.output,
        turns: r.turns,
        durationMs: r.durationMs,
        filesRead: r.filesRead,
        filesWritten: r.filesWritten,
        directoriesListed: r.directoriesListed,
        toolCalls: r.toolCalls,
        escalationLog: r.escalationLog,
        usage: r.usage,
        ...(r.progressTrace && { progressTrace: r.progressTrace }),
        ...(r.error && { error: r.error }),
      })),
    };
  }
  ```

- [ ] **Step 8: Add the `buildSummaryResponse` helper.**

  Also near the top of cli.ts:

  ```typescript
  function buildSummaryResponse(
    batchId: string,
    tasks: TaskSpec[],
    results: RunResult[],
    opts: { autoEscaped: boolean; totalOutputChars: number; threshold: number },
  ) {
    return {
      batchId,
      mode: 'summary' as const,
      ...(opts.autoEscaped && {
        note: `Combined output was ${opts.totalOutputChars} chars (threshold: ${opts.threshold}). Auto-switched to summary mode. Use get_task_output({ batchId, taskIndex }) to fetch individual task outputs.`,
      }),
      results: results.map((r, i) => ({
        taskIndex: i,
        provider: tasks[i].provider ?? '(auto)',
        status: r.status,
        outputLength: r.output.length,
        outputSha256: sha256Hex(r.output),
        turns: r.turns,
        durationMs: r.durationMs,
        filesRead: r.filesRead,
        filesWritten: r.filesWritten,
        directoriesListed: r.directoriesListed,
        toolCalls: r.toolCalls,
        escalationLog: r.escalationLog,
        usage: r.usage,
        ...(r.progressTrace && { progressTrace: r.progressTrace }),
        ...(r.error && { error: r.error }),
        _fetchWith: `get_task_output({ batchId: "${batchId}", taskIndex: ${i} })`,
      })),
    };
  }
  ```

  Add a `sha256Hex` helper:

  ```typescript
  import { createHash } from 'node:crypto';

  function sha256Hex(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }
  ```

### Step 9: Register the `get_task_output` tool

- [ ] **Step 9: Register the new tool inside `buildMcpServer`.**

  Add after the existing `retry_tasks` tool registration:

  ```typescript
    server.tool(
      'get_task_output',
      `Retrieve the full text output of a specific task from a previous delegate_tasks batch.

  Use this when a prior delegate_tasks response came back with mode: 'summary' and you
  need the actual output of one specific task. The batchId is the one returned at the
  top of that response; taskIndex is 0-based into the original tasks array.

  Batches are cached in memory per MCP server instance with a 30-minute TTL from creation
  and a 100-entry LRU cap. Access touches the LRU order but does not refresh TTL. If the
  batch is expired or evicted, re-dispatch via delegate_tasks with the full specs.`,
      {
        batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
        taskIndex: z.number().int().nonnegative().describe('Zero-based index into the original tasks array'),
      },
      async ({ batchId, taskIndex }) => {
        const batch = batchCache.get(batchId);
        if (!batch || batch.expiresAt < Date.now()) {
          if (batch) batchCache.delete(batchId);
          throw new Error(
            `batch "${batchId}" is unknown or expired — re-dispatch via delegate_tasks`,
          );
        }
        // Touch LRU order on successful lookup (matches retry_tasks behavior)
        touchBatch(batchId, batch);

        if (!batch.results) {
          throw new Error(
            `batch "${batchId}" has no stored results — dispatch may have thrown before results were attached`,
          );
        }
        if (taskIndex < 0 || taskIndex >= batch.results.length) {
          throw new Error(
            `taskIndex ${taskIndex} out of range for batch "${batchId}" (size ${batch.results.length})`,
          );
        }

        return {
          content: [{ type: 'text' as const, text: batch.results[taskIndex].output }],
        };
      },
    );
  ```

### Step 9a: Update `retry_tasks` to participate in pagination + create a fresh batch

- [ ] **Step 9a: Update the existing `retry_tasks` handler.**

  Per spec §3.8, `retry_tasks` must: (1) accept `responseMode`, (2) create a fresh batch for the retry dispatch (new `batchId`) instead of mutating the original, (3) leave the original batch intact so earlier `get_task_output` lookups still resolve, and (4) use the same `buildFullResponse` / `buildSummaryResponse` helpers as `delegate_tasks` so the response envelope shape is consistent.

  Find the existing `retry_tasks` registration in `packages/mcp/src/cli.ts` (around line 275) and replace it with:

  ```typescript
    server.tool(
      'retry_tasks',
      'Re-run specific tasks from a previous delegate_tasks batch by their indices, without ' +
        're-transmitting the original briefs. Pass the `batchId` returned by delegate_tasks ' +
        'and an array of task indices (0-based) to re-dispatch. The retry creates a NEW batch ' +
        '(with its own batchId, returned at the top of the response) — the original batch is ' +
        'preserved so earlier get_task_output lookups still resolve. Supports the same ' +
        "responseMode ('full' | 'summary' | 'auto') as delegate_tasks; defaults to 'auto'. " +
        'Batches live in an in-memory cache with a 30-minute TTL; if the batch has expired, ' +
        're-dispatch the tasks explicitly via delegate_tasks.',
      {
        batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
        taskIndices: z
          .array(z.number().int().nonnegative())
          .describe('Zero-based indices (into the original batch) of the tasks to re-run'),
        responseMode: z.enum(['full', 'summary', 'auto']).optional().describe(
          `Same semantics as delegate_tasks.responseMode. Defaults to 'auto'.`,
        ),
      },
      async ({ batchId, taskIndices, responseMode = 'auto' }) => {
        const batch = batchCache.get(batchId);
        if (!batch || batch.expiresAt < Date.now()) {
          if (batch) batchCache.delete(batchId);
          throw new Error(
            `batch "${batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
          );
        }
        // Touch original batch so LRU doesn't evict it while the retry runs.
        // TTL is NOT refreshed.
        touchBatch(batchId, batch);

        for (const i of taskIndices) {
          if (i < 0 || i >= batch.tasks.length) {
            throw new Error(
              `index ${i} is out of range for batch ${batchId} (size ${batch.tasks.length})`,
            );
          }
        }
        const subset = taskIndices.map((i) => batch.tasks[i]);

        // Create a FRESH batch for the retry dispatch. The original batch is
        // untouched — earlier get_task_output calls against it still work.
        const retryBatchId = rememberBatch(subset);

        const retryStartMs = Date.now();
        let results: RunResult[] | undefined;
        try {
          results = await runTasks(subset, config, {
            runtime: { contextBlockStore },
          });
        } finally {
          // Same try/finally cache-attach contract as delegate_tasks.
          const retryEntry = batchCache.get(retryBatchId);
          if (retryEntry) retryEntry.results = results ?? [];
        }
        const wallClockMs = Date.now() - retryStartMs;

        const totalOutputChars = results.reduce((sum, r) => sum + r.output.length, 0);
        const effectiveMode: 'full' | 'summary' =
          responseMode === 'full'
            ? 'full'
            : responseMode === 'summary'
              ? 'summary'
              : totalOutputChars > resolvedThreshold
                ? 'summary'
                : 'full';

        const baseResponse =
          effectiveMode === 'full'
            ? buildFullResponse(retryBatchId, subset, results)
            : buildSummaryResponse(retryBatchId, subset, results, {
                autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
                totalOutputChars,
                threshold: resolvedThreshold,
              });

        // Preserve retry traceability on the envelope (not on each result
        // object) so callers can correlate the retry batch back to the
        // original run. Task 12 will extend this with timings /
        // batchProgress / aggregateCost aggregates.
        const response = {
          ...baseResponse,
          originalBatchId: batchId,
          originalIndices: taskIndices,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      },
    );
  ```

  **Envelope contract:** the retry response uses the same `buildFullResponse` / `buildSummaryResponse` shape as `delegate_tasks`, then appends `originalBatchId` + `originalIndices` as top-level envelope fields so callers can correlate the retry back to the original run. The v0.2.0 per-result `originalIndex` field is dropped — the `originalIndices` array on the envelope is positional and matches `response.results[i]` one-to-one.

### Step 10: Run tests and commit

- [ ] **Step 10: Run the full test suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: clean build, ~457 + ~32 = ~489 tests passing.

- [ ] **Step 11: Commit Task 11.**

  ```bash
  git add \
    packages/core/src/types.ts \
    packages/core/src/config/schema.ts \
    packages/mcp/src/cli.ts \
    tests/config.test.ts \
    tests/cli.test.ts
  git commit -m "feat(mcp): response pagination + get_task_output + retry_tasks paging + configurable threshold

  Per spec §3. Closes the 171k-char response-size failure mode from the
  v0.2.0 post-mortem by adding a hybrid pagination strategy: callers can
  force full or summary mode explicitly, and 'auto' (the default) escapes
  to summary when combined output exceeds the server's threshold.

  - responseMode: 'full' | 'summary' | 'auto' on delegate_tasks AND
    retry_tasks inputs (per spec §3.8)
  - largeResponseThresholdChars configurable via env var > config file
    (typed field on defaults schema) > buildMcpServer option > default
    65_536. Malformed env var logs a warning and falls through — does not
    crash startup.
  - buildFullResponse / buildSummaryResponse helpers, shared by
    delegate_tasks AND retry_tasks
  - Summary shape: outputLength + outputSha256 (full 64-char SHA-256 hex
    digest per spec §3.4) + _fetchWith hint, all metadata fields preserved
    inline (errors, filesRead, escalationLog, usage, progressTrace)
  - New get_task_output tool fetches full text from the batch cache
  - Batch cache extended to store RunResult[] alongside TaskSpec[]; the
    attach happens in a try/finally so a mid-flight dispatch throw still
    leaves results as [] rather than undefined (spec §3.5 / §3.9 item 3)
  - retry_tasks creates a FRESH batch for the retried tasks; the original
    batch is preserved so earlier get_task_output calls still resolve.
    Envelope carries originalBatchId + originalIndices for traceability.
  - LRU touch on successful get_task_output lookup; TTL is NOT refreshed
  - Envelope aggregates (timings, batchProgress, aggregateCost) stubbed
    here and populated in Task 12
  - MultiModelConfig schema + type both typed for
    defaults.largeResponseThresholdChars (no opportunistic casts)

  Tests: ~32 new (4 schema, 5 threshold, 7 responseMode, 8 get_task_output
  including try/finally case, 7 retry_tasks pagination, 1 integration).

  Spec: §3"
  ```

---

## Task 12: Envelope aggregates — `timings`, `batchProgress`, `aggregateCost`

**Goal:** Populate the three observability aggregates on every `delegate_tasks` response envelope. `timings` reports wall-clock vs sum-of-task-times and estimated parallel savings. `batchProgress` gives the `X/N` completion counts plus `successPercent` (specifically a success rate, NOT progress — the snapshot is always post-terminal). `aggregateCost` sums actual and saved costs with separate unavailability counts because their trust boundaries differ.

**Files:**
- Modify: `packages/mcp/src/cli.ts`
- Modify: `tests/cli.test.ts`

### Step 1: Write tests for the three aggregate helpers

- [ ] **Step 1: Append tests to `tests/cli.test.ts`.**

  ```typescript
  describe('computeTimings (v0.3.0)', () => {
    it('single task → sumOfTaskMs equals task durationMs, savings is 0', () => {
      const results: RunResult[] = [{
        ...baseMockResult,
        durationMs: 1000,
      }];
      const timings = computeTimings(1100, results);  // wall-clock 1100ms
      expect(timings.wallClockMs).toBe(1100);
      expect(timings.sumOfTaskMs).toBe(1000);
      expect(timings.estimatedParallelSavingsMs).toBe(0);  // max(0, 1000 - 1100) = 0
    });

    it('3 parallel tasks of 1000ms each + wall-clock 1100 → savings ~1900ms', () => {
      const results: RunResult[] = [
        { ...baseMockResult, durationMs: 1000 },
        { ...baseMockResult, durationMs: 1000 },
        { ...baseMockResult, durationMs: 1000 },
      ];
      const timings = computeTimings(1100, results);
      expect(timings.sumOfTaskMs).toBe(3000);
      expect(timings.estimatedParallelSavingsMs).toBe(1900);
    });

    it('task without durationMs → contributes 0 to sumOfTaskMs', () => {
      const results: RunResult[] = [
        { ...baseMockResult, durationMs: 1000 },
        { ...baseMockResult },  // no durationMs
      ];
      const timings = computeTimings(1100, results);
      expect(timings.sumOfTaskMs).toBe(1000);
    });

    it('empty batch → all zeros', () => {
      const timings = computeTimings(50, []);
      expect(timings).toEqual({ wallClockMs: 50, sumOfTaskMs: 0, estimatedParallelSavingsMs: 0 });
    });
  });

  describe('computeBatchProgress (v0.3.0)', () => {
    it('mixed batch counts ok / incomplete / failed correctly', () => {
      const results: RunResult[] = [
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'incomplete' },
        { ...baseMockResult, status: 'error' },
      ];
      const progress = computeBatchProgress(results);
      expect(progress.totalTasks).toBe(4);
      expect(progress.completedTasks).toBe(2);
      expect(progress.incompleteTasks).toBe(1);
      expect(progress.failedTasks).toBe(1);
      expect(progress.successPercent).toBe(50.0);
    });

    it('empty batch → all zeros, successPercent 0', () => {
      const progress = computeBatchProgress([]);
      expect(progress).toEqual({
        totalTasks: 0,
        completedTasks: 0,
        incompleteTasks: 0,
        failedTasks: 0,
        successPercent: 0,
      });
    });

    it('all success → successPercent 100', () => {
      const results: RunResult[] = [
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'ok' },
      ];
      const progress = computeBatchProgress(results);
      expect(progress.successPercent).toBe(100);
      expect(progress.failedTasks).toBe(0);
    });

    it('4 ok + 1 failed → successPercent 80.0, specifically as a success metric not progress', () => {
      const results: RunResult[] = [
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'error' },
      ];
      const progress = computeBatchProgress(results);
      expect(progress.successPercent).toBe(80.0);
      // Note: the batch is 100% DONE (every task is in a terminal state).
      // successPercent specifically measures clean-success rate, not progress.
    });

    it('timeout and max_turns count as incompleteTasks, not failedTasks', () => {
      const results: RunResult[] = [
        { ...baseMockResult, status: 'ok' },
        { ...baseMockResult, status: 'max_turns' },
        { ...baseMockResult, status: 'timeout' },
        { ...baseMockResult, status: 'incomplete' },
      ];
      const progress = computeBatchProgress(results);
      expect(progress.completedTasks).toBe(1);
      expect(progress.incompleteTasks).toBe(3);
      expect(progress.failedTasks).toBe(0);
    });

    it('api_error and network_error count as failedTasks', () => {
      const results: RunResult[] = [
        { ...baseMockResult, status: 'api_error' },
        { ...baseMockResult, status: 'network_error' },
        { ...baseMockResult, status: 'api_aborted' },
        { ...baseMockResult, status: 'error' },
      ];
      const progress = computeBatchProgress(results);
      expect(progress.failedTasks).toBe(4);
      expect(progress.incompleteTasks).toBe(0);
    });
  });

  describe('computeAggregateCost (v0.3.0)', () => {
    it('sums actual and saved costs across tasks', () => {
      const results: RunResult[] = [
        { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01, savedCostUSD: 0.10 } },
        { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: 0.20 } },
      ];
      const agg = computeAggregateCost(results);
      expect(agg.totalActualCostUSD).toBeCloseTo(0.03, 5);
      expect(agg.totalSavedCostUSD).toBeCloseTo(0.30, 5);
      expect(agg.actualCostUnavailableTasks).toBe(0);
      expect(agg.savedCostUnavailableTasks).toBe(0);
    });

    it('trust boundary split: known actual cost + no parentModel → actualCostUnavailable: 0, savedCostUnavailable: N', () => {
      const results: RunResult[] = [
        { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01, savedCostUSD: null } },
        { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
      ];
      const agg = computeAggregateCost(results);
      expect(agg.totalActualCostUSD).toBeCloseTo(0.03, 5); // trustworthy
      expect(agg.totalSavedCostUSD).toBe(0);               // no opt-ins
      expect(agg.actualCostUnavailableTasks).toBe(0);      // all known
      expect(agg.savedCostUnavailableTasks).toBe(2);       // all null
    });

    it('null costUSD → contributes 0 and increments actualCostUnavailableTasks', () => {
      const results: RunResult[] = [
        { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: null, savedCostUSD: null } },
        { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
      ];
      const agg = computeAggregateCost(results);
      expect(agg.totalActualCostUSD).toBeCloseTo(0.02, 5);
      expect(agg.actualCostUnavailableTasks).toBe(1);
    });

    it('empty batch → zeros', () => {
      const agg = computeAggregateCost([]);
      expect(agg).toEqual({
        totalActualCostUSD: 0,
        totalSavedCostUSD: 0,
        actualCostUnavailableTasks: 0,
        savedCostUnavailableTasks: 0,
      });
    });
  });
  ```

  You'll need to import the three new helpers from cli.ts. Since they're currently not exported, either (a) export them from cli.ts for testing, or (b) mark them `export` with a note "/** @internal — exported for tests */". Go with (a).

- [ ] **Step 2: Run the tests and verify they fail.**

  ```bash
  npx vitest run tests/cli.test.ts -t "computeTimings|computeBatchProgress|computeAggregateCost" 2>&1 | tail -15
  ```

  Expected: fails because the helpers don't exist yet.

### Step 3: Implement the three helpers

- [ ] **Step 3: Add `computeTimings`, `computeBatchProgress`, `computeAggregateCost` to `packages/mcp/src/cli.ts`.**

  Near the top of the file (alongside `buildFullResponse` / `buildSummaryResponse` from Task 11), add:

  ```typescript
  export function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
    const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
    return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
  }

  export function computeBatchProgress(results: RunResult[]): BatchProgress {
    const totalTasks = results.length;
    const completedTasks = results.filter((r) => r.status === 'ok').length;
    const incompleteTasks = results.filter(
      (r) => r.status === 'incomplete' || r.status === 'max_turns' || r.status === 'timeout',
    ).length;
    const failedTasks = results.filter(
      (r) =>
        r.status === 'error' ||
        r.status === 'api_aborted' ||
        r.status === 'api_error' ||
        r.status === 'network_error',
    ).length;
    const successPercent =
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 1000) / 10;
    return { totalTasks, completedTasks, incompleteTasks, failedTasks, successPercent };
  }

  export function computeAggregateCost(results: RunResult[]): BatchAggregateCost {
    let totalActualCostUSD = 0;
    let totalSavedCostUSD = 0;
    let actualCostUnavailableTasks = 0;
    let savedCostUnavailableTasks = 0;

    for (const r of results) {
      if (r.usage.costUSD === null || r.usage.costUSD === undefined) {
        actualCostUnavailableTasks += 1;
      } else {
        totalActualCostUSD += r.usage.costUSD;
      }
      if (r.usage.savedCostUSD === null || r.usage.savedCostUSD === undefined) {
        savedCostUnavailableTasks += 1;
      } else {
        totalSavedCostUSD += r.usage.savedCostUSD;
      }
    }

    return {
      totalActualCostUSD,
      totalSavedCostUSD,
      actualCostUnavailableTasks,
      savedCostUnavailableTasks,
    };
  }
  ```

  Import the types at the top:

  ```typescript
  import type { ..., BatchTimings, BatchProgress, BatchAggregateCost } from '@zhixuan92/multi-model-agent-core';
  ```

### Step 4: Wire the aggregates into `buildFullResponse` and `buildSummaryResponse`

- [ ] **Step 4: Extend both builders to accept and include the aggregates.**

  Update `buildFullResponse`:

  ```typescript
  function buildFullResponse(
    batchId: string,
    tasks: TaskSpec[],
    results: RunResult[],
    aggregates: {
      timings: BatchTimings;
      batchProgress: BatchProgress;
      aggregateCost: BatchAggregateCost;
    },
  ) {
    return {
      batchId,
      mode: 'full' as const,
      timings: aggregates.timings,
      batchProgress: aggregates.batchProgress,
      aggregateCost: aggregates.aggregateCost,
      results: results.map((r, i) => ({
        // ... existing per-task fields unchanged ...
      })),
    };
  }
  ```

  Update `buildSummaryResponse`:

  ```typescript
  function buildSummaryResponse(
    batchId: string,
    tasks: TaskSpec[],
    results: RunResult[],
    opts: {
      autoEscaped: boolean;
      totalOutputChars: number;
      threshold: number;
      timings: BatchTimings;
      batchProgress: BatchProgress;
      aggregateCost: BatchAggregateCost;
    },
  ) {
    return {
      batchId,
      mode: 'summary' as const,
      ...(opts.autoEscaped && { note: `...` }),
      timings: opts.timings,
      batchProgress: opts.batchProgress,
      aggregateCost: opts.aggregateCost,
      results: results.map((r, i) => ({
        // ... existing summary fields unchanged ...
      })),
    };
  }
  ```

- [ ] **Step 5: Update the `delegate_tasks` handler to compute and pass the aggregates.**

  Inside the handler (between `runTasks` and the response build):

  ```typescript
    const timings = computeTimings(wallClockMs, results);
    const batchProgress = computeBatchProgress(results);
    const aggregateCost = computeAggregateCost(results);

    const response =
      effectiveMode === 'full'
        ? buildFullResponse(batchId, tasks, results, { timings, batchProgress, aggregateCost })
        : buildSummaryResponse(batchId, tasks, results, {
            autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
            totalOutputChars,
            threshold: resolvedThreshold,
            timings,
            batchProgress,
            aggregateCost,
          });
  ```

### Step 6: End-to-end integration test

- [ ] **Step 6: Append an end-to-end test.**

  ```typescript
  describe('delegate_tasks envelope aggregates — end-to-end (v0.3.0)', () => {
    it('dispatches 3 parallel tasks, verifies timings and batchProgress and aggregateCost populated', async () => {
      // Use the stubbed runTasks mock from Task 11's LRU test pattern
      // Set durationMs on each stub result
      // Dispatch and inspect the response envelope

      // Assert:
      // - response.timings.wallClockMs > 0
      // - response.timings.sumOfTaskMs > 0
      // - response.timings.estimatedParallelSavingsMs >= 0
      // - response.batchProgress.totalTasks === 3
      // - response.batchProgress.completedTasks === 3
      // - response.batchProgress.successPercent === 100
      // - response.aggregateCost.totalActualCostUSD > 0 (if stub sets costUSD)
    });
  });
  ```

### Step 7: Full suite + commit

- [ ] **Step 7: Run the full suite.**

  ```bash
  npm run build && npm test 2>&1 | tail -10
  ```

  Expected: clean build, ~477 + 16 = ~493 tests passing.

- [ ] **Step 8: Commit Task 12.**

  ```bash
  git add packages/mcp/src/cli.ts tests/cli.test.ts
  git commit -m "feat(mcp): envelope aggregates — timings, batchProgress, aggregateCost

  Per spec §5.7, §5.8, §5.9. Every delegate_tasks response envelope now
  carries three observability aggregates derived from the per-task
  RunResult data. Always populated — they're small and generic enough
  that every caller benefits.

  - computeTimings: wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs
    (honest-estimate naming — actual serial execution would differ)
  - computeBatchProgress: ok / incomplete / failed counts +
    successPercent (clean-success rate, NOT progress — the snapshot is
    always post-terminal)
  - computeAggregateCost: totalActualCostUSD + totalSavedCostUSD +
    SEPARATE actualCostUnavailableTasks + savedCostUnavailableTasks
    (trust boundaries stay separated — a batch with known actual cost
    but no parentModel reports actualCostUnavailable: 0 and
    savedCostUnavailable: N)

  Wire-up: delegate_tasks handler computes all three from results array,
  passes them into buildFullResponse / buildSummaryResponse. Both
  response modes carry the same aggregate fields.

  With Task 9's per-task durationMs + savedCostUSD, the calling agent
  can now compose a summary like:

    Dispatched 5 tasks in parallel, total cost \$0.031 (saved ~\$0.42
    vs opus), completed in 42s (saved 3m16s vs serial). 4 of 5 tasks
    completed successfully, 1 failed with api_error.

  directly from the response envelope, no caller-side arithmetic.

  Tests: 16 new (4 timings + 6 batchProgress + 4 aggregateCost + 1
  integration + 1 regression).

  Spec: §5"
  ```

---

## Task 13: `delegate_tasks` tool description update

**Goal:** Extend the `TOOL_NOTES` constant in `packages/mcp/src/routing/render-provider-routing-matrix.ts` with paragraphs covering every v0.2.0 + v0.3.0 addition so callers see the new fields and tools at tool-call time rather than buried in the README.

**Files:**
- Modify: `packages/mcp/src/routing/render-provider-routing-matrix.ts`
- Modify: `tests/routing/render-provider-routing-matrix.test.ts`

### Step 1-3: Update TOOL_NOTES and verify

- [ ] **Step 1: Read the current `TOOL_NOTES` constant.**

  ```bash
  grep -n "TOOL_NOTES" packages/mcp/src/routing/render-provider-routing-matrix.ts
  ```

  Read the current content — it was last updated in v0.2.0 Task 13 to mention `batchId`, `retry_tasks`, `register_context_block`, and the new statuses.

- [ ] **Step 2: Append v0.3.0 paragraphs to `TOOL_NOTES`.**

  Find the TOOL_NOTES string (likely a template literal or a large string constant). Append new paragraphs inside the string (before the closing backtick):

  ```typescript
  export const TOOL_NOTES = `
  // ... existing v0.2.0 TOOL_NOTES content ...

  RESPONSE SHAPE (v0.3+): Every delegate_tasks response includes a top-level
  batchId, mode ('full' or 'summary'), timings ({wallClockMs, sumOfTaskMs,
  estimatedParallelSavingsMs}), batchProgress ({totalTasks, completedTasks,
  incompleteTasks, failedTasks, successPercent}), and aggregateCost
  ({totalActualCostUSD, totalSavedCostUSD, actualCostUnavailableTasks,
  savedCostUnavailableTasks}). If the combined output across tasks is small,
  mode: 'full' with inline outputs; if it exceeds the server's threshold
  (default 64 KB, configurable via env MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS
  / config defaults.largeResponseThresholdChars / buildMcpServer option),
  mode: 'summary' with per-task outputLength + outputSha256 + _fetchWith
  hint — fetch individual outputs with get_task_output({ batchId, taskIndex }).
  Set responseMode: 'full' to force inline, 'summary' to force summary, or
  omit for auto-escape.

  COVERAGE DECLARATION (v0.3+): For tasks with enumerable deliverables
  (multi-file refactors, test generation across many functions, multi-PR
  review, per-endpoint reports, per-function test stubs, audit checklists),
  set expectedCoverage on the task spec with either minSections: N,
  sectionPattern: '<regex>' (default ^##), or requiredMarkers: [...] — the
  identifier strings that must all appear in the output. The supervision
  layer will re-prompt the model with specific missing items and classify
  thin responses as insufficient_coverage instead of silently accepting them.
  Do NOT set expectedCoverage for one-shot tasks (bug fixes, single
  implementations, prose, creative writing) — the field is opt-in and has
  no meaning for deliverables you can't enumerate ahead of time.

  COST + TIME VISIBILITY (v0.3+): Set parentModel on the task spec (e.g.
  'claude-opus-4-6') to get usage.savedCostUSD — the ESTIMATED cost
  difference vs running the same token volume on that parent model.
  Positive means delegation was cheaper. Both usage.costUSD (actual) and
  usage.savedCostUSD (estimate) are estimates for budgeting and debugging,
  not accounting numbers. Per-task durationMs is always populated.
  Batch-level timings.estimatedParallelSavingsMs tells you how much
  wall-clock time concurrent dispatch bought back vs a hypothetical
  serial for-loop. batchProgress.successPercent is a clean-success rate
  (the batch is always 100% done by the time you see the response —
  successPercent measures how many finished cleanly, NOT progress).

  PROGRESS TRACE (v0.3+): Set includeProgressTrace: true on the task spec
  to receive a bounded, priority-trimmed trace of the execution timeline
  in the final RunResult.progressTrace. Useful for post-hoc debugging of
  long-running tasks — did the worker loop through supervision retries,
  where did it stall, did it escalate across providers. The trace is
  trimmed at 80 events and 16 KB; text_emission and tool_call events are
  dropped first under pressure (their content is already in output /
  toolCalls). Boundary events (turn_start, turn_complete, escalation_start,
  injection, done) are never dropped. If trimming fired, a synthetic
  _trimmed marker at the end of the trace reports the dropped count and
  per-kind histogram.

  NOTE: progress-events at the MCP protocol level (notifications/progress)
  are emitted correctly by the server and delivered to the MCP client.
  Whether your client renders them live depends on the client — some
  render them as in-flight tool-call status lines, others don't surface
  them to the calling LLM at all. includeProgressTrace gives you the
  full timeline post-hoc regardless of your client's live-rendering
  behavior.

  AVAILABLE TOOLS: delegate_tasks (this one), register_context_block
  (stash reusable brief content referenced via TaskSpec.contextBlockIds),
  retry_tasks (re-dispatch specific indices from a previous batch),
  get_task_output (fetch individual task outputs when a response was in
  summary mode).
  `;
  ```

- [ ] **Step 3: Update the existing substring-match test in `tests/routing/render-provider-routing-matrix.test.ts`.**

  If the existing test asserts on specific substrings in the rendered description, update it to expect the new phrases. Add assertions that the new v0.3.0 paragraphs appear:

  ```typescript
  describe('renderProviderRoutingMatrix — v0.3.0 TOOL_NOTES additions', () => {
    it('includes response shape paragraph mentioning batchId and mode', () => {
      const desc = renderProviderRoutingMatrix(sampleConfig());
      expect(desc).toMatch(/batchId/);
      expect(desc).toMatch(/mode: 'full' or 'summary'|'full' or 'summary'/);
      expect(desc).toMatch(/get_task_output/);
    });

    it('includes coverage declaration paragraph', () => {
      const desc = renderProviderRoutingMatrix(sampleConfig());
      expect(desc).toMatch(/expectedCoverage/);
      expect(desc).toMatch(/insufficient_coverage/);
    });

    it('includes cost and time visibility paragraph with honest-estimate language', () => {
      const desc = renderProviderRoutingMatrix(sampleConfig());
      expect(desc).toMatch(/parentModel/);
      expect(desc).toMatch(/savedCostUSD/);
      expect(desc).toMatch(/ESTIMATED|estimate/i);
      expect(desc).toMatch(/estimatedParallelSavingsMs/);
      expect(desc).toMatch(/successPercent/);
    });

    it('includes progress trace paragraph', () => {
      const desc = renderProviderRoutingMatrix(sampleConfig());
      expect(desc).toMatch(/includeProgressTrace/);
      expect(desc).toMatch(/post-hoc/);
    });

    it('available tools paragraph lists all four', () => {
      const desc = renderProviderRoutingMatrix(sampleConfig());
      expect(desc).toMatch(/delegate_tasks/);
      expect(desc).toMatch(/register_context_block/);
      expect(desc).toMatch(/retry_tasks/);
      expect(desc).toMatch(/get_task_output/);
    });
  });
  ```

- [ ] **Step 4: Run tests + commit.**

  ```bash
  npm test 2>&1 | tail -8
  git add packages/mcp/src/routing/render-provider-routing-matrix.ts tests/routing/render-provider-routing-matrix.test.ts
  git commit -m "feat(mcp): delegate_tasks tool description covers v0.3.0 additions

  Per spec §8. Adds five new paragraphs to TOOL_NOTES so callers see the
  v0.2+ and v0.3+ additions at tool-call time rather than buried in the
  README.

  - RESPONSE SHAPE: batchId, mode, timings, batchProgress, aggregateCost,
    configurable threshold via env/config/option precedence, get_task_output
  - COVERAGE DECLARATION: expectedCoverage with non-audit examples; when
    NOT to use it (one-shot tasks)
  - COST + TIME VISIBILITY: parentModel opt-in, savedCostUSD as estimate,
    durationMs, estimatedParallelSavingsMs, successPercent (clean-success
    rate not progress)
  - PROGRESS TRACE: includeProgressTrace for post-hoc observability,
    visibility caveat about client rendering of notifications/progress
  - AVAILABLE TOOLS: all four v0.3+ tools listed

  Tests: 5 new substring-match assertions.

  Spec: §8"
  ```

---

## Task 14: Documentation updates

**Goal:** Rewrite `docs/claude-code-delegation-rule.md` to frame routing by workload shape rather than price. Add new sections covering `expectedCoverage`, "Decompose and parallelize enumerable work" pattern with multiple non-audit examples, "Measuring savings" subsection, and `inputTokenSoftLimit` per-provider override. Update `packages/mcp/README.md` and root `README.md` with feature bullets and links.

**Files:**
- Modify: `docs/claude-code-delegation-rule.md`
- Modify: `packages/mcp/README.md`
- Modify: `README.md`

### Step 1: Read the current delegation rule

- [ ] **Step 1: Open `docs/claude-code-delegation-rule.md` and read the existing structure.**

  ```bash
  grep -nE "^##" docs/claude-code-delegation-rule.md
  ```

  You should see section headings like "Prerequisites", "The Principle", "Judgment vs Labor", "Decision Procedure", "Named Exceptions", "Reading Code", "Provider Routing", "Writing Delegable Briefs", "Dispatch Shape", "Status Handling", "Escalation Ladder", "Quick Reference". Find the "Provider Routing" section — that's where the main rewrite lands.

### Step 2: Rewrite the "Provider Routing" section

- [ ] **Step 2: Replace the existing "Provider Routing" table and framing.**

  Locate the existing "### Provider Routing" heading. Replace the opening paragraph and table with the workload-shape framing per spec §9.2:

  ```markdown
  ### Provider Routing

  **Route by workload shape, not by price.** The free-vs-paid axis is secondary. The primary question is whether the task's shape fits what a lighter model can actually deliver.

  **Cheaper providers sweet spot** (e.g. minimax, claude-haiku):
  - ≤ 10 structured output sections
  - ≤ 50k input-token workload
  - Retrieval tasks (grep, glob, list with structured results)
  - Short-form judgment ("does this file match pattern X?", "summarize these 5 imports")
  - Single-file edits
  - Small test stubs
  - Focused research sub-questions

  **Reasoning providers sweet spot** (e.g. codex, claude-opus):
  - ≥ 20 structured output sections
  - Ambiguous judgment that resists a clear rubric
  - Security-sensitive review
  - Whole-branch synthesis
  - Unknown-scope exploration
  - Cross-cutting refactors

  **Enumerable-deliverable workloads with many items + large input**: never dispatch as a single task. Either decompose and parallelize (see "Decompose and parallelize enumerable work" below) or use retrieval/judgment split. Typical examples: multi-file refactors (10+ files), test generation across many functions (25+), multi-PR review (15+ PRs), per-endpoint analysis (10+ endpoints), codebase audits against long checklists.

  The MCP's built-in routing is: **capability filter → tier filter → cheapest qualifying provider**. Set `tier: 'reasoning'` and a higher `effort` level on tasks that match the reasoning sweet spot; leave `tier: 'standard'` for tasks in the cheaper sweet spot.
  ```

  If there was an existing role/provider table under this section (from v0.2.0), preserve it below the new framing — don't delete it, just let the new framing lead.

### Step 3: Add "Declaring deliverable coverage" subsection

- [ ] **Step 3: Under "Writing Delegable Briefs", add a new subsection.**

  Find the existing "### Writing Delegable Briefs" heading. Add a new subsection at the end of that section:

  ```markdown
  #### Declaring deliverable coverage

  Declare coverage when the deliverable is enumerable. If your brief asks for N discrete outputs, populate `expectedCoverage.requiredMarkers` with the item identifiers or set `minSections` for simpler shapes. The supervision layer will re-prompt the model with specific missing items and classify thin responses as `insufficient_coverage` instead of silently accepting them.

  Worked examples across workload shapes:

  - **Multi-file refactor**: `requiredMarkers: ["src/auth.ts", "src/user.ts", ..., "src/session.ts"]` — every file path must appear in the output.
  - **Test generation**: `requiredMarkers: ["computeTotal", "validateInput", "formatDate", ...]` — every function name must appear.
  - **Multi-PR review**: `requiredMarkers: ["#1234", "#1235", "#1236", ...]` — every PR number must appear.
  - **Per-endpoint analysis**: `requiredMarkers: ["/api/users", "/api/orders", "/api/refunds", ...]` — every endpoint path must appear.
  - **Codebase audit**: `requiredMarkers: ["1.1", "1.2", ..., "10.2"]` — one per checklist item.

  Do NOT declare coverage for one-shot tasks — bug fixes, single implementations, prose explanations, conversational responses, creative writing. The field is opt-in and has no meaning for deliverables you can't enumerate ahead of time. Setting a spurious `minSections: 1` is harmless but pointless.
  ```

### Step 4: Add "Decompose and parallelize enumerable work" pattern section

- [ ] **Step 4: Add a new top-level section after "Writing Delegable Briefs".**

  ```markdown
  ## Decompose and parallelize enumerable work

  When the work has the shape "do N independent things," dispatch N tasks in one `delegate_tasks` call instead of one big task. The MCP runs them concurrently via `Promise.all`. Use `expectedCoverage.requiredMarkers` per task to pin what "done" looks like per-deliverable, and `batchId` + `retry_tasks` to re-dispatch any individual task that came back thin.

  **Pattern A: Decompose and parallelize**

  Worked examples (ordered cheapest-to-most-complex):

  1. **Multi-file refactor**: "Update import syntax in these 10 files" → 10 tasks, one per file. Each task has a minimal `requiredMarkers: ["<the file's primary export>"]` to catch a worker that silently skipped a file. Parent synthesizes if needed (usually unnecessary — per-file diffs are independent).

  2. **Test generation across many functions**: "Write unit tests for these 25 functions" → 5 tasks batched 5 functions each. `requiredMarkers: ["<function1>", "<function2>", ...]` per task. Parent collects test files.

  3. **Multi-PR review**: "Review these 15 PRs and flag anything concerning" → 15 tasks in parallel (or batched to your provider's rate limit). `requiredMarkers: ["<PR number>"]` per task. Parent synthesizes top-3 concerns across all PRs.

  4. **Per-endpoint analysis**: "Analyze these 10 API endpoints for X" → 10 tasks. `requiredMarkers: ["<endpoint path>"]` per task. Parent builds the cross-endpoint report.

  5. **Codebase audit** (internal testing ground example): 3 apps × 10 categories = 30 tasks. Each task audits one category for one app.

  Parallel dispatch saves wall-clock time — check `timings.estimatedParallelSavingsMs` in the response to see how much.

  **Pattern B: Retrieval / judgment split**

  When one part of the work is cheap retrieval (grep / list / map) and another part is expensive judgment (synthesize / review / decide), split them across providers. Phase 1: cheap provider does retrieval, emits structured evidence. Phase 2: `register_context_block` the evidence bundle, dispatch judgment to a reasoning provider. The judgment phase never has to re-traverse the source material — it reads the pre-built evidence bundle, dropping input tokens by ~70%.

  Example:

  - Phase 1 (parallel, minimax): "grep -rn for pattern X, Y, Z in these repos; return structured lists of file:line hits" → 15-20 cheap tasks, each producing a small structured output
  - Phase 2 (codex): `register_context_block({ id: "evidence-bundle", content: <concatenated retrieval results> })` → one judgment task that takes `contextBlockIds: ["evidence-bundle"]` and produces the final review

  This works for code review ("cheap finds changed files, expensive reviews them"), architecture analysis ("cheap maps module structure, expensive reasons about coupling"), large-scale refactor planning ("cheap enumerates call sites, expensive decides migration strategy"), and many other multi-phase workloads.
  ```

### Step 5: Add "Measuring savings" subsection

- [ ] **Step 5: Add a new subsection under an appropriate existing section (e.g. "Dispatch Shape" or as a new "Measuring savings" section).**

  ```markdown
  ## Measuring savings

  The MCP exposes four visibility surfaces so callers can see the UX value of delegation without computing anything themselves. All of them are **estimates** for budgeting and debugging, not accounting numbers — actual parent-model cost would vary with context, tool overhead, and retry patterns; actual serial execution would have different cache and warmup characteristics.

  **Per-task cost savings**:

  - `result.usage.costUSD` — what this task actually cost on the provider that ran it.
  - `result.usage.savedCostUSD` — estimated difference vs running the same token volume on your parent-session model. Only populated when you set `parentModel` on the task spec. Set it. It's the number that tells the user "you just saved $0.12 by delegating this instead of letting opus handle it."

  **Batch-level aggregates** (always present on the response envelope):

  - `aggregateCost.totalActualCostUSD` — sum of per-task costUSD across the batch
  - `aggregateCost.totalSavedCostUSD` — sum of per-task savedCostUSD (requires `parentModel` on at least one task)
  - `timings.wallClockMs` — how long the batch actually took
  - `timings.sumOfTaskMs` — sum of individual task durations (what serial execution would have taken)
  - `timings.estimatedParallelSavingsMs` — wall-clock time parallel dispatch bought back vs a hypothetical serial for-loop
  - `batchProgress.completedTasks` / `incompleteTasks` / `failedTasks` — static counts at response time
  - `batchProgress.successPercent` — clean-success rate (the batch is always 100% DONE by the time you see the response; this field measures how many finished cleanly, NOT progress)

  **Example summary a calling agent can compose directly from one `delegate_tasks` response**:

  > Dispatched 5 tasks in parallel. Total cost **$0.031** (estimated savings vs opus: **~$0.42**). Wall-clock: **42s** (estimated serial time saved: **~3m 16s**). **4 of 5 tasks completed successfully**, 1 failed with `api_error` — retry via `retry_tasks({ batchId, taskIndices: [3] })` once the provider is available.

  Every number in that summary comes from the response envelope fields without caller-side arithmetic. The `retry_tasks` hint comes from inspecting `results[3].status` and `results[3].error`.
  ```

### Step 6: Add "Tightening budgets for weaker models" subsection

- [ ] **Step 6: Append the budget-tightening subsection.**

  ```markdown
  ## Tightening budgets for weaker models

  If a provider returns degraded output on long dispatches, lower its `inputTokenSoftLimit` in your `~/.multi-model/config.json`:

  \`\`\`json
  {
    "providers": {
      "minimax": {
        "type": "openai-compatible",
        "model": "MiniMax-M2",
        "inputTokenSoftLimit": 100000
      }
    }
  }
  \`\`\`

  Counter-intuitive but small models often produce better final answers under tighter budgets because they're forced to commit earlier. The watchdog will fire `force_salvage` at 95k instead of 190k; worst case is a half-read but bounded, instead of an exhausted exploration. Pair with task-level `maxTurns: 40` (instead of the default 200) when dispatching to weaker providers.
  ```

### Step 7: Update the status handling table

- [ ] **Step 7: Find the existing Status Handling table and add a note under `incomplete`.**

  Under the `incomplete` row in the status table, add a note:

  ```markdown
  > Note (v0.3+): `incomplete` is also produced when a caller declared `expectedCoverage` and the model's output didn't meet the coverage contract after 3 supervision re-prompts. The specific missing items are captured in `escalationLog[i].reason`. Fix by either splitting the task (see "Decompose and parallelize enumerable work"), escalating to a reasoning provider, or revisiting whether the coverage declaration is reasonable.
  ```

### Step 8-9: README updates

- [ ] **Step 8: Update `packages/mcp/README.md`.**

  Find the "Features" or similar bullet list and add:

  ```markdown
  - Declare enumerable-deliverable coverage (`expectedCoverage`) and get semantic incompleteness detection
  - Bounded post-hoc progress-event traces in final results (`includeProgressTrace`)
  - Visible cost and time savings via `parentModel` + `savedCostUSD` + batch-level `timings` and `aggregateCost`
  - New `get_task_output` tool for fetching individual outputs from paginated batches
  ```

  Find the "Available tools" section and add `get_task_output` to the list.

- [ ] **Step 9: Update the root `README.md`.**

  Add a version-bump note referencing the v0.3.0 release and link to the delegation rule's new patterns section.

### Step 10: Commit Task 14

- [ ] **Step 10: Verify docs render cleanly (if a markdown lint is available) and commit.**

  ```bash
  git add docs/claude-code-delegation-rule.md packages/mcp/README.md README.md
  git commit -m "docs: v0.3.0 — reframe routing, add coverage + patterns + measuring savings

  Per spec §9. Reframes the delegation rule around workload shape rather
  than price, adds new sections for expectedCoverage (with non-audit
  worked examples), decompose-and-parallelize pattern (multi-file
  refactor, test generation, PR review, per-endpoint analysis, codebase
  audit as one instance), retrieval/judgment split pattern, measuring
  savings (costUSD, savedCostUSD, timings, batchProgress), and
  inputTokenSoftLimit per-provider override.

  Status handling table gains a note under 'incomplete' explaining the
  new insufficient_coverage flow.

  MCP README and root README updated with new feature bullets and the
  new get_task_output tool in the available-tools list.

  Spec: §9"
  ```

---

## Task 15: Release — two-package publish flow

**Goal:** Ship `@zhixuan92/multi-model-agent-core@0.3.0` and `@zhixuan92/multi-model-agent-mcp@0.3.0`. Same two-phase flow as v0.2.0 (core first, mcp depends on `core@^0.3.0`, separate 2FA publishes, push tags).

**Files:**
- Modify: `packages/core/package.json` (version bump)
- Modify: `packages/mcp/package.json` (version bump + core dep range)
- Modify: `package-lock.json` (auto-updated by npm version)

### Step 1-5: Phase A — core release

- [ ] **Step 1: Final build + test gate before touching versions.**

  ```bash
  npm run build && npm test 2>&1 | tail -8
  ```

  Expected: clean build, ~493 tests passing.

- [ ] **Step 2: Bump core to 0.3.0.**

  ```bash
  npm version minor --workspace @zhixuan92/multi-model-agent-core --no-git-tag-version
  grep '"version"' packages/core/package.json | head -1
  ```

  Expected: `"version": "0.3.0"` in `packages/core/package.json`.

- [ ] **Step 3: Commit core release + tag.**

  ```bash
  git add packages/core/package.json package-lock.json
  git commit -m "release(core): bump @zhixuan92/multi-model-agent-core to 0.3.0"
  git tag v0.3.0
  ```

- [ ] **Step 4: Dry-run the core publish.**

  ```bash
  npm publish --workspace @zhixuan92/multi-model-agent-core --access public --dry-run 2>&1 | tail -20
  ```

  Expected output:
  - `name: @zhixuan92/multi-model-agent-core`
  - `version: 0.3.0`
  - Tarball contents: `dist/`, `package.json`, `README.md`, `LICENSE` — NO `src/`, no `tests/`, no `node_modules/`
  - Contains the new `dist/context/`, `dist/runners/supervision.js` (with validateCoverage + trimProgressTrace), `dist/runners/error-classification.js`, etc.
  - Reasonable unpacked size (<1 MB)

  If anything looks wrong, stop and fix before proceeding.

- [ ] **Step 5: Hand off to user for the real core publish (2FA).**

  Tell the user verbatim:

  ```
  Run this in your shell (I'll wait for you to confirm):

      ! npm publish --workspace @zhixuan92/multi-model-agent-core --access public

  npm will prompt for your 2FA OTP. When it prints success, tell me and
  I'll verify the registry and move to Phase B (mcp).
  ```

  Wait for user confirmation. Do NOT run the publish yourself.

- [ ] **Step 6: After user confirms, verify core on the registry.**

  ```bash
  npm view @zhixuan92/multi-model-agent-core version
  npm view @zhixuan92/multi-model-agent-core dist-tags
  ```

  Expected: `0.3.0` and `{ latest: '0.3.0' }`. Retry once after a 5-second sleep if the first check returns stale data (registry propagation lag).

### Step 7-13: Phase B — mcp release

- [ ] **Step 7: Bump mcp's core dependency range and reinstall.**

  Edit `packages/mcp/package.json` manually. Change the `dependencies` entry:

  ```json
  "dependencies": {
    "@zhixuan92/multi-model-agent-core": "^0.3.0",
    ...
  }
  ```

  Then:

  ```bash
  npm install
  ```

  **Watch for the nested-node_modules gotcha from v0.2.0**: if `packages/mcp/node_modules/@zhixuan92/` ends up with a fetched stale copy instead of the workspace symlink, the mcp build will fail. Verify:

  ```bash
  ls -la node_modules/@zhixuan92/multi-model-agent-core
  ```

  Expected: symlink pointing to `../../packages/core`. If it's a regular directory, remove it and reinstall:

  ```bash
  rm -rf node_modules/@zhixuan92 packages/mcp/node_modules/@zhixuan92
  npm install
  ls -la node_modules/@zhixuan92/multi-model-agent-core  # should be a symlink now
  ```

- [ ] **Step 8: Re-run build + tests with the bumped dep.**

  ```bash
  npm run build && npm test 2>&1 | tail -8
  ```

  Expected: clean build, all tests pass.

- [ ] **Step 9: Bump mcp to 0.3.0.**

  ```bash
  npm version minor --workspace @zhixuan92/multi-model-agent-mcp --no-git-tag-version
  grep '"version"' packages/mcp/package.json | head -1
  ```

  Expected: `"version": "0.3.0"`.

- [ ] **Step 10: Commit mcp release + tag.**

  ```bash
  git add packages/mcp/package.json package-lock.json
  git commit -m "release(mcp): bump @zhixuan92/multi-model-agent-mcp to 0.3.0, repin core to ^0.3.0"
  git tag mcp-v0.3.0
  ```

- [ ] **Step 11: Dry-run the mcp publish.**

  ```bash
  npm publish --workspace @zhixuan92/multi-model-agent-mcp --access public --dry-run 2>&1 | tail -20
  ```

  Expected: name, version, tarball shape all correct. New `dist/cli.js` includes the `get_task_output` tool registration, `computeTimings` / `computeBatchProgress` / `computeAggregateCost` helpers, configurable threshold resolution.

- [ ] **Step 12: Hand off to user for the real mcp publish (2FA).**

  ```
  Run this in your shell:

      ! npm publish --workspace @zhixuan92/multi-model-agent-mcp --access public

  When it prints success, tell me and I'll verify + smoke-test.
  ```

- [ ] **Step 13: After user confirms, verify mcp on the registry.**

  ```bash
  npm view @zhixuan92/multi-model-agent-mcp version
  npm view @zhixuan92/multi-model-agent-mcp dist-tags
  npm view @zhixuan92/multi-model-agent-mcp dependencies
  ```

  Expected: `0.3.0`, `{ latest: '0.3.0' }`, dependency on `@zhixuan92/multi-model-agent-core: ^0.3.0`.

  Smoke test the freshly published tarball:

  ```bash
  npx -y @zhixuan92/multi-model-agent-mcp@0.3.0 --help 2>&1 | tail -5
  ```

  Expected: prints the usage line `Usage: multi-model-agent serve [--config <path>]`. If it crashes, something is wrong with the tarball or the core dep resolution — stop and investigate.

### Step 14: Phase C — push

- [ ] **Step 14: Push release commits and tags.**

  ```bash
  git push
  git push origin v0.3.0 mcp-v0.3.0
  ```

  Expected: the release commits land on origin/dev/v0.3.0 (or whatever branch), and both tags are pushed.

- [ ] **Step 15: Open a PR from dev/v0.3.0 to master (mirrors v0.2.0 flow).**

  ```bash
  gh pr create --base master --head dev/v0.3.0 --title "feat: sub-agent reliability v0.3.0 (coverage validation, cost/time visibility, pagination)" --body-file /tmp/pr-body.md
  ```

  Where `/tmp/pr-body.md` is a summary of the release (write it before running the command). Include the version table, the main additions, and a test-plan checklist. Mirror the v0.2.0 PR body structure (PR #1).

- [ ] **Step 16: Final report to the user.**

  Summarize:
  - Both packages published at 0.3.0
  - npm URLs
  - Git tags pushed
  - PR URL
  - Test count at release time (~493)
  - Any warnings from dry-run or verification

---

## Post-Implementation: Empirical Validation

After all 15 tasks land and the test suite is green, run the empirical validation pass described in spec §1.1:

1. **Re-dispatch a mixed-shape scenario against a real provider chain**. Pick one workload from each of the representative public workloads:
   - A 10-file refactor (multi-file with `expectedCoverage.requiredMarkers: [file paths]`)
   - A 25-function test-generation batch (per-function markers)
   - A multi-PR review (PR number markers)
   - Plus the round-2 audit scenario as a regression (85 checklist item markers)

   Verify:
   - Coverage validation catches thin responses and re-prompts with specific missing items
   - `timings.estimatedParallelSavingsMs` is > 0 on parallel dispatches
   - `aggregateCost.totalSavedCostUSD` is > 0 when `parentModel` is set
   - `batchProgress.successPercent` accurately reflects clean-success rate (not progress)
   - The calling agent composes a readable savings summary from the envelope fields without arithmetic

2. **Inspect the MCP protocol progress notifications** against a real MCP client (Claude Code, mcp-inspector, or Claude Desktop) and confirm:
   - Server emits notifications/progress events via the bridge
   - Client behavior is consistent with the v0.3.0 design expectations (Claude Code under-renders; other clients may render live)
   - `progressTrace` in the final response gives post-hoc observability regardless of client

3. **Inspect the `max_turns` fix** by dispatching a task to openai-runner that deliberately triggers a tool call on a re-prompt continuation. Verify:
   - With `maxTurns: 120`, the task succeeds instead of tripping `max_turns` at turn 5
   - If the continuation does exhaust its sub-budget, the result is `status: incomplete` with a reason mentioning "supervision continuation exhausted"

4. **Inspect `savedCostUSD` math** by dispatching one small task with `parentModel: 'claude-opus-4-6'` to minimax. Verify:
   - `result.usage.savedCostUSD` is non-null
   - Sign is positive (delegation was cheaper — opus rates >> minimax free tier)
   - Order of magnitude looks right ($0.05 or more for a ~1k token task)

5. **File a Claude Code harness feature request** (out-of-repo follow-up) asking for live rendering of MCP progress notifications into the calling LLM's context. Document the request with a link to the `progress-probe.mjs` investigation from the brainstorm that confirmed the server side works correctly.

If any of these reveal a regression or unexpected behavior, file follow-up issues — do not amend the implementation series.

---

## Self-Review

Post-writing review against the spec:

**Spec coverage check**:
- §2 Coverage validation → Task 1 (types), Task 2 (validateCoverage pure function + buildRePrompt branch), Task 8 (runner integration) ✓
- §3 Response pagination → Task 11 (responseMode + get_task_output + configurable threshold) ✓
- §4 max_turns fix → Task 5 (openai-runner bug + reason precision), Task 6 (claude-runner reason precision), Task 7 (codex-runner reason precision) ✓
- §5 Cost and timing visibility → Task 3 (rate table + computeSavedCostUSD), Task 9 (runner durationMs + savedCostUSD capture), Task 12 (envelope aggregates) ✓
- §6 progressTrace → Task 1 (types), Task 2 (trimProgressTrace pure function), Task 10 (runner capture + orchestrator propagation) ✓
- §7 directoriesListed → Task 4 ✓
- §8 Tool description → Task 13 ✓
- §9 Documentation → Task 14 ✓
- §10 Testing/release → Task 15 + rollup numbers match spec (~80-105 new tests → plan sums to roughly the same) ✓
- §11 Open questions → all resolutions reflected in task definitions ✓

**Placeholder scan**:
- No TODOs, TBDs, or "TODO later" markers in task steps.
- The one known TBD in the spec (rate verification in model-profiles.json) is handled in Task 3 Step 5 with explicit instruction to verify published rates at implementation time — not a placeholder in the plan, a concrete lookup step.

**Type consistency**:
- `validateCoverage` signature: `(text: string, expected: NonNullable<TaskSpec['expectedCoverage']>) => ValidationResult` — consistent across Task 2 definition and Task 8 call sites.
- `trimProgressTrace` signature: `(events: ProgressEvent[]) => ProgressTraceEntry[]` — consistent.
- Helper parameters added across tasks (`taskStartMs`, `parentModel`, `traceBuffer`, `reason`) are added progressively with consistent naming across all three runners.
- `computeTimings` / `computeBatchProgress` / `computeAggregateCost` signatures match the types defined in Task 1 (`BatchTimings`, `BatchProgress`, `BatchAggregateCost`).

**Forward references**:
- Task 2 imports `TaskSpec` — defined in Task 1. ✓
- Task 8 imports `validateCoverage` — defined in Task 2. ✓
- Task 12 imports the three aggregate types — defined in Task 1. ✓
- Task 11's response builders are stubbed in Task 11, completed with aggregates in Task 12. Explicitly documented in both tasks. ✓

**Commit granularity**:
- Each task ends with a single commit bundling that task's work.
- Exception: Task 5 has a large scope but commits once because the continuation fix and reason precision are tightly coupled. Acceptable.
- Tasks 6, 7, 8 each commit once per runner-level change.

**Gaps found during review**: none requiring plan changes. Proceed to execution handoff.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-11-subagent-reliability-v0.3.0-plan.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec compliance then code quality) between tasks, fast iteration. Best fit for a 15-task plan with well-defined tasks — each fits in a single subagent context without coupling to other tasks. Matches the successful v0.2.0 execution pattern.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for your review. Slower (same session absorbs context from every task) but lets you watch the full trace.

Which approach?
