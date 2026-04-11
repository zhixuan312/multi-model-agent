# Sub-Agent Reliability and Ergonomics v0.3.0 — Design Spec

**Date:** 2026-04-11
**Target release:** `@zhixuan92/multi-model-agent-core@0.3.0` + `@zhixuan92/multi-model-agent-mcp@0.3.0`
**Depends on:** v0.2.0 (merged 2026-04-11) — everything in this spec is additive on top of the four-layer architecture (prevention → recovery → salvage → escalation) and the streaming / context-blocks / retry infrastructure shipped in v0.2.0.
**Post-mortem source:** round 2 of the Gumi audit (2026-04-11), which exercised v0.2.0 against an 85-item checklist workload across three apps and cleanly separated what v0.2.0 got right from what it still misses.

---

## 1. Overview and scope

### 1.1 Core value and problem statement

**Core value.** `multi-model-agent` delegates labor away from the expensive parent session — typically running on Opus or another frontier model — to cheaper sub-agents running on providers like minimax (free), gpt-5-codex (mid-tier), or claude-haiku (cheap). Every delegated task saves parent-session tokens (judgment stays with the parent; execution goes to the worker) and, for independent tasks dispatched in one batch, wall-clock time (the MCP runs them concurrently via `Promise.all`). v0.3.0's main additions exist to serve this core value in three ways:

1. **Make the savings visible to the user** — add per-task and batch-level cost/time metrics so callers can see "you just saved $0.42 and 3 minutes by delegating instead of burning parent context."
2. **Make the tool forgiving of workload shapes that pushed v0.2.0's supervision into blind spots** — add coverage validation so a thin response to a brief with enumerable deliverables is caught and re-prompted instead of silently accepted.
3. **Make the response shape ergonomic for workflows with large outputs** — add pagination so long responses don't overflow client-side tool-result size limits.

Representative public workloads this release must serve (not audit-specific):

- *"Refactor these 10 files to use the new API"*
- *"Review this 800-line PR and flag issues"*
- *"Generate unit tests for these 25 functions"*
- *"Research the Fastify plugin ecosystem and summarize"*
- *"Fix the failing tests in this branch"*
- *"Explain how this authentication flow works"*

**The round-2 audit of the Gumi codebase is the testing ground that surfaced the specific gaps this release closes — not the target workload.** Every item in scope below must be defensibly useful for a random public caller with one of the workloads above; items that only solved one internal audit shape have been dropped or re-scoped during design review.

### 1.1b Specific gaps v0.3.0 closes

Round 2 of the internal audit (2026-04-11) exercised v0.2.0 against an 85-item checklist workload and cleanly separated what worked from what didn't. v0.2.0's supervision, salvage, and escalation layers all did what they were designed for: failures were classified loudly, scratchpad content was preserved where possible, and the chain walker auto-escalated. But the dispatch surfaced **five gaps** that apply to any long-form delegated workload, not just audits:

1. **Semantic incompleteness blind spot.** `validateCompletion` is purely syntactic — a response that covers 40 of 85 checklist items with good evidence passes every current check. One of the three minimax dispatches came back with `status: ok` and a gap report missing roughly half its required sections. The runner has no way to know the brief required 85 sections; only the caller knows.
2. **Large-response size limit.** Three codex reports × ~30k chars = 171k chars in a single `delegate_tasks` tool result. Claude Code's tool layer wrote it to a temp file, breaking normal caller ergonomics.
3. **`max_turns` classification hides its root cause.** A dispatch with `maxTurns: 120` terminated at turn 5 with `status: max_turns`. Root cause: openai-runner's supervision loop passes `maxTurns: 1` to `@openai/agents` on re-prompt continuations, and if the model needs a tool call on the continuation, the SDK throws `MaxTurnsExceededError` which the outer catch classifies as `status: max_turns` regardless of context. Two different failure modes share one label.
4. **`costUSD: null` on every mixed-provider run.** Provider configs that don't set explicit `inputCostPerMTok` / `outputCostPerMTok` produce null costs. A known rate table could populate fallback estimates for the model families we already profile.
5. **Progress-events visibility.** Events are emitted correctly by all three runners, and the MCP bridge sends them via `notifications/progress` per spec. A direct SDK client receives them in real time (verified in this brainstorm via a `progress-probe.mjs` test script — the probe caught two events in 2.3 seconds, proving the server bridge works end-to-end). But Claude Code's MCP client either drops them or renders them in a way that's invisible during a long dispatch. The server cannot fix the client; the server can mitigate by including a bounded trace in the final result so the calling LLM can inspect the timeline after the fact.

Plus two small items worth cleaning up in the same release:

6. **`filesRead` mixes file and directory paths.** Not a bug; a small inconsistency. Fix: additive — keep `filesRead` as-is, add `directoriesListed` alongside. Non-breaking.
7. **`delegate_tasks` tool description doesn't document v0.2.0 / v0.3.0 additions** (`batchId`, `retry_tasks`, `register_context_block`, `expectedCoverage`, `includeProgressTrace`, progress-events visibility caveat). One-paragraph tool description update.

### 1.2 In scope

- **Item 1 — Coverage validation** (§2). Optional `expectedCoverage` on `TaskSpec` with `minSections`, `sectionPattern`, `requiredMarkers`. New `validateCoverage` in supervision, new `insufficient_coverage` DegenerateKind, re-prompt branch. Generic API — applies to any enumerable-deliverable workload (multi-file refactor, test generation, PR review, per-endpoint reports). **Explicitly does NOT include a domain-specific self-consistency mode** — the severity-table helper that was in the initial draft was dropped during design review as audit-specific.
- **Item 2 — Response pagination** (§3). `responseMode: 'full' | 'summary' | 'auto'` on `delegate_tasks` input, threshold-based auto-escape with a **server-configurable threshold** (env var + config file + `buildMcpServer` option), new `get_task_output` tool, batch cache extended to store results. Default threshold is tuned for Claude Code's inline-rendering limit but can be overridden by any consumer whose client handles larger responses.
- **Item 3 — max_turns classification fix** (§4). Raise openai-runner's supervision continuation budget from 1 to 5, add context-aware `MaxTurnsExceededError` catch that distinguishes user-budget-exhausted from supervision-loop-exhausted. Precise `reason` strings on all three runners' max_turns and incomplete paths.
- **Item 4 — costUSD rate table fallback + savings visibility** (§5). Published rates per model family in `model-profiles.json`, `computeCostUSD` falls back when provider config doesn't override. **Plus new savings visibility**: optional `parentModel` on `TaskSpec`, `savedCostUSD` (estimate) on `TokenUsage`, `durationMs` per task, top-level `timings.estimatedParallelSavingsMs` on the batch response, and `batchProgress` aggregate counts. All framed as **estimates**, not accounting truth.
- **Item 5 — progressTrace field** (§6). Opt-in `includeProgressTrace` on `TaskSpec`, bounded per-task trace in the final `RunResult` with priority-based trimming and a `_trimmed` marker. Framed as **generic post-hoc execution observability** for any long-running delegated task, not a client-specific workaround.
- **Item 6 — `directoriesListed` additive field** (§7). New optional string array on `RunResult`. `filesRead` semantics unchanged — this is strictly additive per user instruction.
- **Item 7 — `delegate_tasks` tool description update** (§8). One paragraph covering v0.2.0 + v0.3.0 additions so callers see them at tool-call time.
- **Documentation** (§9). Rewrite the delegation rule's "Provider Routing" section to frame routing by workload shape rather than price. Add new "Decompose and parallelize enumerable work" pattern section leading with non-audit examples. Add "Measuring savings" subsection covering `costUSD`, `savedCostUSD`, `timings`, and `batchProgress`. Document `expectedCoverage` as a generic enumerable-deliverable primitive. Document `inputTokenSoftLimit` per-provider override for weaker models.

### 1.3 Explicitly out of scope

- **Fixing Claude Code's MCP-client UI rendering** of progress events. Not our repo. File upstream after release.
- **Context block TTL extension / `touch_context_block` keep-alive.** Speculative; no one has hit the 30-min limit yet.
- **Indirect thinness signals as warnings** (`lowOutputRatio`, `turnsLow`, `coverageLow`). Likely obviated by coverage validation; revisit only if v0.3.0's `insufficient_coverage` doesn't close the gap observed in round 3.
- **Any breaking changes to `RunResult`, `TaskSpec`, or `AttemptRecord` shape.** Everything new is optional or additive. Existing v0.2.0 callers see zero behavioral change.

### 1.4 Version plan

- `@zhixuan92/multi-model-agent-core` → **0.3.0** (minor — additive type contract expansions)
- `@zhixuan92/multi-model-agent-mcp` → **0.3.0** (minor — new tool, additive response fields)
- Same two-package release flow as v0.2.0 (core first, mcp depends on `core@^0.3.0`)

---

## 2. Coverage validation (item #7 + #8)

### 2.1 Goal

Give callers a declarative way to say *"a complete response must address these N enumerable things"* so the supervision layer can detect semantic incompleteness instead of accepting anything that passes `validateCompletion`'s syntactic checks.

This is a **generic enumerable-deliverable primitive**. It applies to any workload where the caller can list ahead of time what "done" looks like:

- *Multi-file refactor*: `requiredMarkers: ["src/a.ts", "src/b.ts", ..., "src/j.ts"]` — every file must be mentioned in the report
- *Test generation*: `requiredMarkers: ["computeTotal", "validateInput", ...]` — every function must have a corresponding test stub in the output
- *PR review*: `minSections: 5` — at least 5 top-level review sections per PR
- *Per-endpoint reports*: `requiredMarkers: ["/api/users", "/api/orders", ...]` — one block per endpoint
- *Codebase audit* (the internal testing ground): `requiredMarkers: ["1.1", "1.2", ..., "10.2"]` — one per checklist item

### 2.2 New `TaskSpec` field

```ts
export interface TaskSpec {
  // ... existing ...
  /** Optional caller-declared output expectations. When supplied, the
   *  supervision layer runs `validateCoverage` after `validateCompletion`'s
   *  syntactic check passes, and re-prompts with specific missing-item
   *  guidance if coverage is insufficient. Same 3-retry budget as other
   *  degeneracy classes. Opt-in: callers who omit this field see zero
   *  change in runner behavior. Generic across all workload shapes that
   *  produce enumerable deliverables. */
  expectedCoverage?: {
    /** Minimum section count. A section is a line matching `sectionPattern`.
     *  Omit to skip section counting. */
    minSections?: number
    /** Regex for section headings. Default: `^## ` (GFM H2). Applied with
     *  the multiline flag. */
    sectionPattern?: string
    /** Substrings that must ALL appear somewhere in the output. Use this
     *  for workloads where each deliverable has a stable identifier: file
     *  paths for multi-file refactors, function names for test generation,
     *  endpoint paths for per-endpoint reports, item ids for checklists. */
    requiredMarkers?: string[]
  }
}
```

**Note on what was removed during design review**: an earlier draft of this spec included a `selfConsistencySummary: 'severity-table' | false` sub-option that would parse a markdown severity-count table in the output and verify row counts matched per-severity markers in the body. That mode hardcoded a specific audit-report shape (severity/count table header, `**Severity:** critical|moderate|cosmetic` body markers) and was dropped as audit-specific — it would not generalize to multi-file refactor, test generation, PR review, or any of the other representative public workloads. If a similar self-consistency check is needed in the future, it should be designed as a workload-specific pattern in user docs, not as a core supervision primitive.

### 2.3 New `validateCoverage` function

In `packages/core/src/runners/supervision.ts`:

```ts
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

  return { valid: true };
}
```

Only two checks: section count and required markers. Both are generic across every representative workload. No domain-specific parsing, no format assumptions beyond the caller-supplied regex and substring list.

### 2.4 New `DegenerateKind` variant

```ts
export type DegenerateKind =
  | 'empty'
  | 'thinking_only'
  | 'fragment'
  | 'no_terminator'
  | 'insufficient_coverage'  // NEW
```

### 2.5 New `buildRePrompt` branch

```ts
case 'insufficient_coverage':
  return `Your previous answer was structurally valid but does not cover everything the brief required: ${result.reason}. Continue your report by addressing the missing items. Do NOT restart from the beginning — append the missing sections to what you already wrote.`;
```

### 2.6 Runner integration

Each runner's supervision loop gains one call-site addition. After `validateCompletion(stripped).valid === true` and before returning ok, run the coverage check:

```ts
// Existing syntactic check
const validation = validateCompletion(stripped);
if (!validation.valid) {
  // existing degenerate path: increment retries, same-output early-out,
  // inject buildRePrompt(validation), continue
}

// NEW: coverage check — only runs if caller declared expectations
if (task.expectedCoverage) {
  const coverageValidation = validateCoverage(stripped, task.expectedCoverage);
  if (!coverageValidation.valid) {
    // treat identically to a degenerate validation — route through the
    // same retry logic
    validation = coverageValidation;
    // fall through to the degenerate path above
  }
}

// Both checks passed → return ok
return buildXxxOkResult(...);
```

Because `insufficient_coverage` is a `DegenerateKind` like any other, the existing degenerate path handles it automatically — same retry counter, same `sameDegenerateOutput` early-out, same `buildRePrompt` dispatch. ~10 LOC per runner.

When supervision exhausts on `insufficient_coverage`, the runner returns `buildSupervisionExhaustedResult` with `status: incomplete`. `outputIsDiagnostic` is `false` because the output contains real model-produced content (just not enough of it), so the orchestrator's all-fail tier picks it over any diagnostic-only error-flavored attempt from a different provider.

### 2.7 Error cases

- **Invalid `sectionPattern` regex** — return `{ valid: false, kind: 'insufficient_coverage', reason: 'invalid sectionPattern regex: ...' }`. The re-prompt tells the model the regex is broken, though this is really a caller config bug.
- **Empty `requiredMarkers` array** — no-op, trivially passes. Valid declaration meaning "no specific markers required, just the section count."
- **Empty `expectedCoverage` object `{}`** — no-op (all three checks skip). Valid declaration meaning "no coverage enforcement."
- **Caller declares `minSections: 1000` on a small task** — check fails 3 times in a row, supervision exhausts, returns `status: incomplete`. Correct behavior — caller's responsibility to declare reasonable expectations.
- **Marker as substring of other text** (e.g. `"1.1"` inside `"version 1.1.4"`) — false positive in the caller's favor; the marker is "found." Caller can make markers more specific if needed.

### 2.8 Testing

Unit tests in `tests/runners/supervision.test.ts`:

1. `validateCoverage` with no expectations → valid
2. `minSections` met → valid
3. `minSections` not met → insufficient_coverage with count in reason
4. Custom `sectionPattern` matches caller shape
5. Invalid `sectionPattern` regex → insufficient_coverage with compile error in reason
6. All `requiredMarkers` present → valid
7. One marker missing → insufficient_coverage with that marker named
8. Many markers missing → truncated list with `+N more` suffix
9. Empty `requiredMarkers` array → valid (no-op)
10. Combined checks, first fails → fails with first failing check's reason
11. Combined checks, all pass → valid

Re-prompt branch test:

12. `buildRePrompt({ valid: false, kind: 'insufficient_coverage', reason: '...' })` returns a prompt containing the reason and "do not restart"

Runner integration tests (one per runner):

13. Task with `expectedCoverage.requiredMarkers: ['A', 'B', 'C']`, mock output has all three → `status: ok`
14. Same expectation, mock has only 'A', model recovers on retry with all three → `status: ok`, turns reflects the retry
15. Same expectation, mock has only 'A' for all 3 retries → `status: incomplete`, output preserves partial scratchpad, `escalationLog[0].reason` contains `insufficient_coverage`
16. Task without `expectedCoverage` → `validateCoverage` not called (spy assertion)

Cross-runner parity test — same `expectedCoverage` dispatched through all three mocked runners produces identical progress event sequences and identical classification.

Regression test in `tests/runners/supervision-regression.test.ts` — add the round-2 Fate truncated-ok case as a captured output. Assert that `validateCoverage` with the full 85-marker list classifies it as `insufficient_coverage` with the missing markers matching the actual gap.

### 2.9 Performance

All three checks are O(text length) in the worst case. `requiredMarkers` is N × `String.includes` — for 85 markers × 30k chars = ~2.5M character comparisons, single-digit milliseconds. Negligible vs model generation time.

### 2.10 Code volume

- `packages/core/src/types.ts`: +8 LOC (new field, new `DegenerateKind` variant)
- `packages/core/src/runners/supervision.ts`: +70 LOC (`validateCoverage`, `buildRePrompt` branch) — smaller than the pre-delta estimate because the severity-table helpers were dropped
- Each runner: +10 LOC
- Tests: +150 LOC

Total: ~260 LOC. (Down from ~380 LOC after dropping the audit-specific self-consistency mode.)

---

## 3. Response pagination (item #2)

### 3.1 Goal

Prevent `delegate_tasks` responses from exceeding Claude Code's inline tool-result size limit (empirically ~80 KB based on the 171k-char failure in round 2), while keeping small dispatches inline and zero-round-trip.

### 3.2 New `delegate_tasks` input field

```ts
responseMode?: 'full' | 'summary' | 'auto'  // default: 'auto'
```

- `'full'` — always return full outputs inline. Caller takes responsibility for staying under Claude Code's inline limit. Escape hatch.
- `'summary'` — always return summary-only. Caller fetches full content via `get_task_output` per task.
- `'auto'` (default) — return full inline if combined output is small; auto-escape to summary with a `note` when combined output exceeds the threshold.

### 3.3 Configurable threshold

```ts
const DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS = 65_536; // 64 KB
```

Applied to the sum across all tasks in the batch (`results.reduce((n, r) => n + r.output.length, 0)`), not per-task. The default is tuned below Claude Code's observed ~80 KB inline-rendering cutoff with margin — but **the threshold is not hardcoded**. Three layers of override, highest-precedence first:

1. **Env var** `MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS` (positive integer, parsed at server startup)
2. **Config file** `~/.multi-model/config.json` → `defaults.largeResponseThresholdChars` (positive integer)
3. **`buildMcpServer` instance option** `largeResponseThresholdChars` (programmatic API)
4. **Hardcoded default** 65536

Rationale: a public MCP consumer whose client handles multi-MB responses natively should not inherit Claude Code's inline-rendering limit as a universal default. The default is tuned for the primary client (Claude Code) but any deployment can override:

- **Claude Code users** — accept the default, get safe auto-escape behavior
- **Claude Desktop / mcp-inspector / custom SDK clients** with higher limits — set the threshold to `Number.MAX_SAFE_INTEGER` or any large value to effectively disable auto-escape
- **Test environments** — set to `1` to force summary mode on every batch
- **Server administrators** — set via env var or config file without touching caller code

`buildMcpServer` signature gains one optional parameter:

```ts
export function buildMcpServer(
  config: MultiModelConfig,
  options?: {
    /** Character threshold that triggers auto-switch from 'full' to
     *  'summary' response mode when the caller uses `responseMode: 'auto'`
     *  (the default). Defaults to 65_536, tuned for Claude Code's inline
     *  rendering limit. Override per deployment based on your client's
     *  actual tool-result size handling. Precedence (highest first):
     *  env var MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS > config file
     *  defaults.largeResponseThresholdChars > this option > default. */
    largeResponseThresholdChars?: number;
  },
): McpServer
```

The `largeResponseThresholdChars` value is resolved once at server startup and closed over by the `delegate_tasks` handler — it does not re-read on every request.

### 3.4 Response shape

Both modes now carry three new top-level observability fields (`timings`, `batchProgress`, optional `aggregateCost`) derived from the results. These are **always populated** regardless of `responseMode` — they're tiny and generic enough that every caller benefits from seeing them.

**`mode: 'full'`**:

```json
{
  "batchId": "9f8a7b6c-...",
  "mode": "full",
  "timings": {
    "wallClockMs": 42180,
    "sumOfTaskMs": 198430,
    "estimatedParallelSavingsMs": 156250
  },
  "batchProgress": {
    "totalTasks": 5,
    "completedTasks": 4,
    "incompleteTasks": 0,
    "failedTasks": 1,
    "successPercent": 80.0
  },
  "aggregateCost": {
    "totalActualCostUSD": 0.0312,
    "totalSavedCostUSD": 0.4218,
    "actualCostUnavailableTasks": 0,
    "savedCostUnavailableTasks": 0
  },
  "results": [
    {
      "provider": "codex",
      "status": "ok",
      "output": "<full text>",
      "turns": 11,
      "durationMs": 39820,
      "filesRead": [...],
      "filesWritten": [],
      "directoriesListed": [...],
      "toolCalls": [...],
      "escalationLog": [...],
      "usage": {
        "inputTokens": 125000,
        "outputTokens": 4500,
        "totalTokens": 129500,
        "costUSD": 0.0125,
        "savedCostUSD": 0.1560
      },
      "progressTrace": [...]
    }
  ]
}
```

**`mode: 'summary'`**:

```json
{
  "batchId": "9f8a7b6c-...",
  "mode": "summary",
  "note": "Combined output was 171043 chars (threshold: 65536). Auto-switched to summary mode. Use get_task_output({ batchId, taskIndex }) to fetch individual task outputs.",
  "timings": { ... },
  "batchProgress": { ... },
  "aggregateCost": { ... },
  "results": [
    {
      "taskIndex": 0,
      "provider": "codex",
      "status": "ok",
      "outputLength": 28431,
      "outputSha256": "a7b2c8...",
      "turns": 11,
      "durationMs": 39820,
      "filesRead": [...],
      "filesWritten": [],
      "directoriesListed": [...],
      "toolCalls": [...],
      "escalationLog": [...],
      "usage": {
        "inputTokens": 125000,
        "outputTokens": 4500,
        "totalTokens": 129500,
        "costUSD": 0.0125,
        "savedCostUSD": 0.1560
      },
      "progressTrace": [...],
      "_fetchWith": "get_task_output({ batchId: \"9f8a7b6c-...\", taskIndex: 0 })"
    }
  ]
}
```

Key differences from `mode: 'full'`:

- `output` omitted; `outputLength` and `outputSha256` added for integrity checks
- `taskIndex` explicit (removes ambiguity when callers slice the array)
- `_fetchWith` hint string shows the exact MCP call to fetch this task's full output
- `note` at the top level present only when `responseMode: 'auto'` auto-triggered (absent when caller explicitly asked for summary)

`timings`, `batchProgress`, `aggregateCost`, errors, metadata, `filesRead` / `filesWritten` / `directoriesListed` / `toolCalls` / `escalationLog` / `usage` / `progressTrace` / `durationMs` all stay inline in both modes — only `output` is paginated.

See §5 for the semantics and honest-estimate framing of `timings.estimatedParallelSavingsMs`, `aggregateCost.totalSavedCostUSD`, and per-task `usage.savedCostUSD`. See §5 for `durationMs` and `batchProgress`.

### 3.5 Batch cache extension

```ts
const batchCache = new Map<string, {
  tasks: TaskSpec[];
  results?: RunResult[];     // NEW: populated after dispatch returns
  expiresAt: number;
}>();
```

`rememberBatch(tasks)` still fires before dispatch. After `runTasks` returns, the handler attaches `results` to the same cache entry:

```ts
const batchId = rememberBatch(tasks as TaskSpec[]);
let results: RunResult[];
try {
  results = await runTasks(tasks as TaskSpec[], config, { onProgress, runtime: { contextBlockStore } });
} finally {
  const existing = batchCache.get(batchId);
  if (existing) existing.results = results ?? [];
}
```

TTL and LRU semantics unchanged. `touchBatch` fires on `get_task_output` lookup the same way it fires on `retry_tasks` lookup.

### 3.6 New `get_task_output` MCP tool

```ts
server.tool(
  'get_task_output',
  `Retrieve the full text output of a specific task from a previous delegate_tasks batch.
   Use this when a prior delegate_tasks response came back with mode: 'summary' and you
   need the actual output of one specific task. The batchId is the one returned at the
   top of that response; taskIndex is 0-based into the original tasks array.
   Batches are cached in memory per MCP server instance with a 30-minute TTL and
   100-entry LRU cap. Access touches the LRU order but does not refresh TTL. If the
   batch is expired or evicted, re-dispatch via delegate_tasks with the full specs.`,
  {
    batchId: z.string(),
    taskIndex: z.number().int().nonnegative(),
  },
  async ({ batchId, taskIndex }) => {
    const batch = batchCache.get(batchId);
    if (!batch || batch.expiresAt < Date.now()) {
      if (batch) batchCache.delete(batchId);
      throw new Error(
        `batch "${batchId}" is unknown or expired — re-dispatch via delegate_tasks`,
      );
    }
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

### 3.7 `delegate_tasks` handler changes

```ts
// At server startup, resolve the threshold once from env > config > option > default
const resolvedThreshold =
  parsePositiveInt(process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS)
  ?? config.defaults?.largeResponseThresholdChars
  ?? options?.largeResponseThresholdChars
  ?? DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS;

async ({ tasks, responseMode = 'auto' }, extra) => {
  // ... existing progress bridge and batch stash unchanged ...

  // Time the dispatch for the batch-level timings aggregate
  const batchStartMs = Date.now();
  const results = await runTasks(tasks as TaskSpec[], config, { onProgress, runtime: { contextBlockStore } });
  const wallClockMs = Date.now() - batchStartMs;

  // Attach results to the batch cache for get_task_output and retry_tasks
  const batchEntry = batchCache.get(batchId);
  if (batchEntry) batchEntry.results = results;

  // Compute envelope-level observability aggregates (always populated)
  const timings = computeTimings(wallClockMs, results);
  const batchProgress = computeBatchProgress(results);
  const aggregateCost = computeAggregateCost(results);

  // Determine effective response mode (uses resolved, configurable threshold)
  const totalOutputChars = results.reduce((sum, r) => sum + r.output.length, 0);
  const effectiveMode: 'full' | 'summary' =
    responseMode === 'full'
      ? 'full'
      : responseMode === 'summary'
        ? 'summary'
        : totalOutputChars > resolvedThreshold
          ? 'summary'
          : 'full';

  const response =
    effectiveMode === 'full'
      ? buildFullResponse(batchId, tasks, results, { timings, batchProgress, aggregateCost })
      : buildSummaryResponse(batchId, tasks, results, {
          timings,
          batchProgress,
          aggregateCost,
          autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
          totalOutputChars,
          threshold: resolvedThreshold,
        });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
  };
}
```

`parsePositiveInt` is a small helper that parses a string to a positive integer and returns `undefined` on invalid input (so a malformed env var doesn't crash server startup — it just falls through to the next layer of the precedence chain with a warning logged to stderr). `computeTimings`, `computeBatchProgress`, and `computeAggregateCost` are pure functions described in §5.

### 3.8 `retry_tasks` interaction

`retry_tasks` is unchanged at the interface level. Its handler respects the new `responseMode` semantics. It creates a **new** batch for the retry dispatch (its own `batchId`), rather than mutating the original batch's `results` — keeping the original batch intact for further `get_task_output` lookups even after a partial retry.

### 3.9 Edge cases

1. **Empty batch** — `batchId` valid, `results: []`, mode stays `full`, no error.
2. **All tasks failed** — small combined output, mode stays `full`. `get_task_output` still works on failed tasks (returns scratchpad salvage or diagnostic).
3. **Dispatch throws mid-flight** — `try/finally` attaches `results ?? []` so `get_task_output` degrades to "no stored results" rather than a dangling cache entry.
4. **Batch expiry between dispatch and fetch** — 30-min TTL from creation. `get_task_output` returns "unknown or expired" after that.
5. **LRU eviction of a hot batch** — cap is 100 batches. Note in summary response warns callers to fetch promptly.
6. **Empty outputs** — `outputLength: 0`, `outputSha256: <sha256 of empty string>`, `_fetchWith` still present, `get_task_output` returns `""`. Not an error.
7. **Fetch before dispatch completes** — cannot happen at the protocol level; `delegate_tasks` doesn't return until all tasks complete.

### 3.10 Testing

Unit tests in `tests/cli.test.ts`:

1. Small batch + `responseMode: 'auto'` → `mode: 'full'`, no note
2. Small batch + `responseMode: 'summary'` → `mode: 'summary'`, no note (explicit)
3. Large batch + `responseMode: 'auto'` → `mode: 'summary'` with note
4. Large batch + `responseMode: 'full'` → `mode: 'full'` (escape hatch honored)
5. `responseMode` omitted → defaults to auto
6. **Configurable threshold** via `buildMcpServer({ largeResponseThresholdChars: 1 })` → small batch auto-escapes (every byte over threshold)
7. **Configurable threshold** via env var `MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS=1048576` → large batch stays in full mode (threshold raised)
8. **Configurable threshold** env > option precedence — when both are set, env wins
9. **Malformed env var** (non-integer) → falls through to next layer, logs warning, does not crash
10. `get_task_output` valid → returns exact output
11. `get_task_output` unknown batchId → "unknown or expired"
12. `get_task_output` expired → "unknown or expired", cache evicted
13. `get_task_output` out-of-range taskIndex → "out of range"
14. `get_task_output` on batch without stored results → "no stored results"
15. `get_task_output` touches LRU order (verify via stress test)
16. `get_task_output` does NOT refresh TTL
17. Summary shape: every full-mode field except `output` preserved
18. `outputLength` matches `output.length`
19. `outputSha256` is valid sha256 hex
20. `_fetchWith` contains exact batchId and taskIndex

Integration test: dispatch 3 tasks × 30 KB each (combined 90 KB > 64 KB default), verify summary mode fires, round-trip via `get_task_output`, stress LRU with 100 more batches, verify original remains retrievable because fetches touched it.

### 3.11 Code volume

- `packages/mcp/src/cli.ts`: +180 LOC (pagination + threshold resolution + aggregate computation + new get_task_output tool)
- Tests: +280 LOC

Total: ~460 LOC.

---

## 4. Max_turns classification + continuation budget fix (item #3)

### 4.1 Goal

Fix two conflated failure modes that currently share `status: max_turns` in openai-runner, and make `reason` strings on failed attempts precise enough to be actionable without reading the runner source.

### 4.2 Root cause (openai-runner specific)

`packages/core/src/runners/openai-runner.ts` lines 400, 430, 448 each call `runTurnAndBuffer(continueWith(currentResult, ...), 1)` — passing `maxTurns: 1` to the SDK for re-prompt continuations. `@openai/agents` counts each model-reply-to-tool-result as a turn. When a re-prompt causes the model to call a tool:

1. Turn 1: model replies with a tool call. SDK runs the tool. 1 turn consumed.
2. Model needs to reply to the tool result → turn 2 required → exceeds `maxTurns: 1` → `MaxTurnsExceededError` thrown.

The outer catch classifies as `status: 'max_turns'` regardless of which call site threw. User sees `max_turns at turns: 5` with `maxTurns: 120` because the counter reflects cumulative requests (4 from initial + 1 from the continuation that threw).

**Verified via grep**: only openai-runner has this pattern. claude-runner uses streaming input (pushes continuation messages into a queue, no SDK re-invocation). codex-runner is hand-rolled (`while (turns < maxTurns)` with `input.push(...)` + `continue` for re-prompts). The `reason`-precision improvement applies to all three runners, though.

### 4.3 Fix A: raise the continuation sub-budget (openai-runner only)

```ts
// packages/core/src/runners/openai-runner.ts
const SUPERVISION_CONTINUATION_BUDGET = 5;
```

Replace all three `runTurnAndBuffer(..., 1)` call sites with `runTurnAndBuffer(..., SUPERVISION_CONTINUATION_BUDGET)`. 5 gives the model slack to call a tool and reply to the tool result with headroom for a second small tool round.

### 4.4 Fix B: context-aware `MaxTurnsExceededError` catch (openai-runner only)

New local helper `runContinuationTurn` that wraps `runTurnAndBuffer` and returns a discriminated union:

```ts
type ContinuationLabel = 'watchdog-warning' | 'reprompt' | 'reground';
type ContinuationResult =
  | { ok: true; result: AgentRunOutput }
  | { ok: false; cause: 'max-turns-exceeded'; label: ContinuationLabel; turnAtFailure: number };

async function runContinuationTurn(
  input: string | AgentInputItem[],
  label: ContinuationLabel,
): Promise<ContinuationResult> {
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
    throw err; // non-max_turns errors propagate to outer catch
  }
}
```

Call sites become one-liners that explicitly handle supervision-exhausted:

```ts
const contRes = await runContinuationTurn(continueWith(currentResult, warning), 'watchdog-warning');
if (!contRes.ok) {
  emit({ kind: 'done', status: 'incomplete' });
  return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig, {
    reason: `supervision ${contRes.label} continuation exhausted the ${SUPERVISION_CONTINUATION_BUDGET}-turn sub-budget at turn ${contRes.turnAtFailure}`,
  });
}
currentResult = contRes.result;
```

Same pattern at the re-prompt (label `'reprompt'`) and re-grounding (label `'reground'`) call sites.

### 4.5 Fix C: precise reasons on genuine max_turns paths (all three runners)

All three helpers (`buildMaxTurnsResult` in openai-runner, `buildClaudeMaxTurnsResult` in claude-runner, `buildCodexMaxTurnsResult` in codex-runner) gain an optional `{ reason?: string }` parameter. When present, they populate the returned `RunResult.error` field. The orchestrator's `AttemptRecord.reason` already derives from `result.error || 'status=${status}'`, so precise reasons flow through automatically without orchestrator changes.

Reason strings:

- **openai-runner outer catch** (initial call exhausted user budget): `"agent exhausted user-declared maxTurns limit (${maxTurns}) after ${requests} turns"`
- **claude-runner `error_max_turns` signal**: `"claude-agent-sdk signaled error_max_turns after ${turns} turns (user-declared maxTurns: ${maxTurns})"`
- **codex-runner while-loop exit**: `"hand-rolled loop exited after completing ${turns} of ${maxTurns} user-declared turns without producing a clean final answer"`

### 4.6 Fix D: precise reasons on supervision-exhausted paths (all three runners)

`buildSupervisionExhaustedResult` / `buildClaudeIncompleteResult` / `buildCodexIncompleteResult` gain the same `{ reason?: string }` parameter. Call sites populate it with the last-seen degenerate kind:

```ts
return buildSupervisionExhaustedResult(currentResult, scratchpad, tracker, runner.providerConfig, {
  reason: `supervision loop exhausted after ${supervisionRetries} re-prompts (last kind: ${validation.kind ?? 'unknown'})`,
});
```

### 4.7 Final reason strings visible to callers

Callers running `result.escalationLog.map(a => a.reason)` see precise messages like:

- `"agent exhausted user-declared maxTurns limit (120) after 120 turns"` — genuine max_turns
- `"supervision reprompt continuation exhausted the 5-turn sub-budget at turn 7"` — continuation bug edge case
- `"supervision loop exhausted after 3 re-prompts (last kind: fragment)"` — supervision retry cap
- `"supervision loop exhausted after 3 re-prompts (last kind: insufficient_coverage)"` — coverage failure (§2)
- `"claude-agent-sdk signaled error_max_turns after 78 turns (user-declared maxTurns: 120)"` — claude SDK
- `"hand-rolled loop exited after completing 120 of 120 user-declared turns without producing a clean final answer"` — codex loop exit

### 4.8 Testing

Regression for the openai-runner continuation bug: mock the initial call to return after 4 turns with a fragment final output, mock the re-prompt continuation to throw `MaxTurnsExceededError` on turn 1. Verify with budget=5 the second call gets enough budget and succeeds. Verify the helper's catch path (with a failing mock) produces the discriminated-union result.

Reason-precision regression for each runner: dispatch tasks that exhaust supervision retries (3 degenerate mock responses), verify `RunResult.error` contains "supervision loop exhausted after 3 re-prompts" and the last degenerate kind. For the genuine max_turns path, verify `error` contains runner-specific precise text.

Cross-runner parity test: exhaust supervision on each runner with identical mocked degeneracy sequence, verify all three reason strings contain `"supervision loop exhausted"`.

The existing v0.2.0 codex abort-path disambiguation test continues to pass unchanged.

### 4.9 Code volume

- `packages/core/src/runners/openai-runner.ts`: +50 LOC
- `packages/core/src/runners/claude-runner.ts`: +15 LOC
- `packages/core/src/runners/codex-runner.ts`: +15 LOC
- Tests: +120 LOC

Total: ~200 LOC.

---

## 5. Cost and timing visibility (item #4, expanded)

### 5.1 Goal

Make the UX value of delegation visible to callers via six additive fields and one helper section. The old §5 goal ("populate `costUSD` when config doesn't set rates") is now **one of six** sub-features in a unified visibility story:

1. **Rate table fallback** — `computeCostUSD` consults the model profile when the provider config doesn't override, so `costUSD` stops being `null` on every common-case dispatch.
2. **Savings estimate** — new optional `TaskSpec.parentModel` + new `TokenUsage.savedCostUSD` tell the caller "you saved about $X vs running these tokens on your parent session's model."
3. **Per-task duration** — new `RunResult.durationMs` tells the caller how long each individual task actually took.
4. **Batch timings aggregate** — new `timings.wallClockMs` / `timings.sumOfTaskMs` / `timings.estimatedParallelSavingsMs` on the response envelope tell the caller how much wall-clock time concurrent dispatch bought back vs a hypothetical serial for-loop.
5. **Batch progress aggregate** — new `batchProgress` on the response envelope gives a static snapshot of `X/N completed`, `Y failed`, `Z incomplete`.
6. **Aggregate cost** — new `aggregateCost` on the response envelope sums per-task `costUSD` and `savedCostUSD` so the caller doesn't have to compute totals themselves.

**All framed as estimates, not accounting truth.** §5.4 has the honest-framing language that must appear verbatim in the implementation's JSDoc and the delegation rule docs — it matters that users understand these numbers are sanity checks, not invoices.

The problem statement: v0.2.0 round 2 returned `costUSD: null` on every result because neither the `codex` nor `minimax` provider entries had explicit rates set. The caller couldn't answer "did delegation save me money?" without computing everything themselves. v0.3.0 makes the answer legible from the response envelope alone.

### 5.2 Extended `ModelProfile` schema

New optional fields on each profile entry in `packages/core/src/model-profiles.json`:

```json
{
  "prefix": "gpt-5-codex",
  "tier": "reasoning",
  "defaultCost": "high",
  "bestFor": "architecture, security, deep code reasoning",
  "supportsEffort": true,
  "inputTokenSoftLimit": 1000000,
  "inputCostPerMTok": 1.25,         // NEW
  "outputCostPerMTok": 10.0,        // NEW
  "rateSource": "https://...",      // NEW
  "rateLookupDate": "2026-04-11"    // NEW
}
```

`ModelProfile` zod schema in `packages/core/src/routing/model-profiles.ts` gains four optional fields.

### 5.3 `computeCostUSD` fallback

In `packages/core/src/cost.ts`:

```ts
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

### 5.4 Initial rate table

**Rates must be verified at implementation time against each provider's official pricing page.** The design specifies the **mechanism** (fallback in `computeCostUSD` + new profile fields); the first implementation task verifies each rate and commits `model-profiles.json` with source URLs and lookup dates in the `rateSource` / `rateLookupDate` fields.

Profiles to populate (rates TBD, verified at implementation time):

- `gpt-5-codex` (OpenAI Responses API)
- `gpt-5` family default (OpenAI)
- `claude-opus-4-6[1m]` (Anthropic 1M context tier)
- `claude-opus` other (Anthropic standard tier)
- `claude-sonnet` (Anthropic)
- `claude-haiku` (Anthropic)
- `MiniMax-M2` (MiniMax free tier — hardcoded 0/0)
- Default / unmatched — leave fields undefined so `computeCostUSD` returns null for unknown models

### 5.5 Savings estimate — `parentModel` + `savedCostUSD`

New optional field on `TaskSpec`:

```ts
export interface TaskSpec {
  // ... existing ...
  /** Optional hint about the parent session's model. When set, each
   *  result's `usage.savedCostUSD` is computed as an estimated cost
   *  difference versus running the same token volume on this parent
   *  model. Purely informational — does not affect routing, execution,
   *  or any other runner behavior. Use the model identifier that
   *  matches a profile in `model-profiles.json` (e.g. 'claude-opus-4-6',
   *  'claude-opus-4-6[1m]', 'gpt-5-codex'). Unknown models produce
   *  savedCostUSD: null. */
  parentModel?: string
}
```

New optional field on `TokenUsage`:

```ts
export interface TokenUsage {
  // ... existing ...
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
}
```

New helper in `packages/core/src/cost.ts`:

```ts
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
    return null; // Can't estimate without parent rates
  }
  const hypotheticalParentCost =
    (inputTokens / 1_000_000) * parentProfile.inputCostPerMTok +
    (outputTokens / 1_000_000) * parentProfile.outputCostPerMTok;
  return hypotheticalParentCost - actualCostUSD;
}
```

Each runner populates `savedCostUSD` when building the final `RunResult` by calling `computeSavedCostUSD(...)` with the task's `parentModel` and the resolved token counts.

### 5.6 Per-task `durationMs`

New optional field on `RunResult`:

```ts
export interface RunResult {
  // ... existing ...
  /** Wall-clock duration of this task in milliseconds, from the runner's
   *  first line of work to the moment the final RunResult was built.
   *  Optional for backward-compat with pre-v0.3.0 mock results, but
   *  runners always populate it in v0.3.0+. Used by the delegate_tasks
   *  response to compute the batch-level timings aggregate. */
  durationMs?: number
}
```

Each runner captures `const taskStartMs = Date.now()` at the top of `run()` and sets `durationMs: Date.now() - taskStartMs` on every return path (ok, incomplete, max_turns, timeout, error — all the existing helper functions gain this field). Trivial to add because each helper already closes over the runner's scope.

### 5.7 Batch timings aggregate

New top-level field on the `delegate_tasks` response envelope:

```ts
timings: {
  /** Wall-clock milliseconds from the start of `runTasks` to the moment
   *  the final response is built. This is what the caller actually
   *  waited for. */
  wallClockMs: number
  /** Sum of every task's individual durationMs. Represents the
   *  hypothetical serial execution time if the tasks had run one after
   *  another in a for-loop. */
  sumOfTaskMs: number
  /** Estimated wall-clock savings vs serial execution:
   *    sumOfTaskMs - wallClockMs
   *  Always ≥ 0 (parallel can't take longer than serial in the
   *  aggregate). THIS IS AN ESTIMATE — a real serial for-loop would
   *  have had different cache/warmup characteristics, different
   *  context-pressure dynamics on the models, and possibly different
   *  tool sequences. The number is useful as "approximately what
   *  parallelism bought you" but not as a precise measurement. */
  estimatedParallelSavingsMs: number
}
```

Computed once at the end of the handler via:

```ts
function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
  const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
  return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
}
```

Always populated — the computation is a handful of arithmetic operations. Callers can ignore it if they don't care; there's no cost to having it present.

### 5.8 Batch progress aggregate

New top-level field on the `delegate_tasks` response envelope:

```ts
batchProgress: {
  /** Total number of tasks in the batch. */
  totalTasks: number
  /** Tasks where status === 'ok'. */
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
```

Computed once via:

```ts
function computeBatchProgress(results: RunResult[]): BatchProgress {
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
```

This is a **static snapshot** — it reflects the batch state at the moment the response is built (which is after every task has completed or errored out, because `delegate_tasks` waits for the full `Promise.all`). Every task is in a terminal state by the time the caller sees this. That's why the field is named `successPercent` rather than `progressPercent`: there's no "progress" to measure in a post-completion snapshot, only the success rate of the completed batch.

**Explicitly not in scope for v0.3.0**: live state transitions (`queued` / `running` / `waiting_for_tools` / `supervision_retry` / `escalating`). These would only be meaningful over a live channel that the calling LLM can observe mid-flight — which Claude Code's MCP client does not currently render for progress notifications (verified in brainstorm investigation). Without a live client that can surface these, the infrastructure cost of the live state machine doesn't pay off. Deferred until either Claude Code's rendering improves or a companion `get_batch_status(batchId)` poll tool is designed. Users of this static snapshot can still display `"3 of 5 tasks completed, 1 returned partial work, 1 failed"` — the common case for public callers.

### 5.9 Aggregate cost

New top-level field on the `delegate_tasks` response envelope:

```ts
aggregateCost: {
  /** Sum of every task's usage.costUSD (tasks with null costUSD
   *  contribute 0 and are counted in `actualCostUnavailableTasks`).
   *  This is what the caller actually paid for the batch, in aggregate. */
  totalActualCostUSD: number
  /** Sum of every task's usage.savedCostUSD (tasks with null
   *  savedCostUSD contribute 0 and are counted in
   *  `savedCostUnavailableTasks`). Only meaningful when at least one
   *  task had `parentModel` set and both sides had pricing data.
   *  Can be 0 if nobody opted in to savings estimation. */
  totalSavedCostUSD: number
  /** How many tasks had `costUSD: null` (unknown provider rates,
   *  custom models without profile data, etc) and therefore did NOT
   *  contribute to `totalActualCostUSD`. Separate from the savings
   *  unavailability count because the two have different trust
   *  boundaries: actual cost and saved cost are independent. */
  actualCostUnavailableTasks: number
  /** How many tasks had `savedCostUSD: null` (missing `parentModel`,
   *  unknown parent-model rates, etc) and therefore did NOT contribute
   *  to `totalSavedCostUSD`. A batch where every task has known actual
   *  cost but no task sets `parentModel` will have
   *  `actualCostUnavailableTasks: 0` and `savedCostUnavailableTasks:
   *  totalTasks` — the actual-cost aggregate is fully trustworthy
   *  while the savings aggregate is a pure zero. Callers read both
   *  counts to decide how much to trust each of the two totals. */
  savedCostUnavailableTasks: number
}
```

Computed similarly to §5.7 and §5.8 — a few reduce calls over `results`. Always present.

The calling LLM can compose a summary like:

> Dispatched 5 tasks in parallel. Total cost: **$0.031** (estimated savings vs parent model: **~$0.42**). Wall-clock: **42s** (estimated serial time saved: **~3m 16s**). **4 of 5 completed successfully**, 1 failed.

All five numbers come directly from `timings`, `batchProgress`, and `aggregateCost` on the response envelope, with no caller-side arithmetic.

### 5.10 Testing

Extend `tests/cost.test.ts`:

1. Provider config rates set → uses config rates (unchanged)
2. Config rates unset + model profile has rates → uses profile rates (new fallback)
3. Config rates unset + model profile has no rates → null (unchanged)
4. Each profile with rates produces a sane non-null number for known token counts
5. `MiniMax-M2` computes 0 regardless of token volume (free tier)
6. `computeSavedCostUSD` with parent + actual rates → correct positive number
7. `computeSavedCostUSD` with parent unset → null
8. `computeSavedCostUSD` with unknown parent model → null
9. `computeSavedCostUSD` with actualCostUSD null → null
10. `computeSavedCostUSD` when parent is cheaper than actual (unusual routing) → negative number

New tests in `tests/cli.test.ts` for aggregate observability:

11. `computeTimings` with single task → wallClockMs equals sumOfTaskMs, estimatedParallelSavingsMs is 0
12. `computeTimings` with 3 parallel tasks at 1000ms each, wall-clock 1100ms → estimatedParallelSavingsMs ≈ 1900ms
13. `computeBatchProgress` counts ok / incomplete / failed correctly for a mixed batch
14. `computeBatchProgress` with empty batch → all zeros, `successPercent: 0`
15. `computeBatchProgress` where every task succeeds → `successPercent: 100` and `failedTasks: 0`
16. `computeBatchProgress` where 4 tasks succeed + 1 fails → `successPercent: 80.0`, the `successPercent` specifically measures clean-success rate, not progress (every task is in a terminal state so "progress" would always be 100%)
17. `computeAggregateCost` sums actual and saved costs correctly across tasks
18. `computeAggregateCost` counts `actualCostUnavailableTasks` and `savedCostUnavailableTasks` **separately** — a batch where every task has known `costUSD` but no task sets `parentModel` reports `actualCostUnavailableTasks: 0` and `savedCostUnavailableTasks: N` (actual cost aggregate is trustworthy; savings aggregate is not)
19. Runner integration: a task with `parentModel: 'claude-opus-4-6'` → result.usage.savedCostUSD is non-null and positive
20. Runner integration: a task without `parentModel` → result.usage.savedCostUSD is null
21. Runner integration: `durationMs` is populated on every RunResult return path (ok, incomplete, error, timeout, max_turns)
22. End-to-end: dispatch 3 tasks in parallel, verify `timings.estimatedParallelSavingsMs > 0`

Extend `tests/routing/model-profiles.test.ts`:

23. Schema accepts optional rate fields
24. Invariant: profiles with `inputCostPerMTok` set also have `outputCostPerMTok` set (rates come as pairs)

### 5.11 Code volume

- `packages/core/src/cost.ts`: +50 LOC (`computeCostUSD` fallback + new `computeSavedCostUSD`)
- `packages/core/src/routing/model-profiles.ts`: +4 LOC (schema)
- `packages/core/src/model-profiles.json`: rate entries per profile
- `packages/core/src/types.ts`: +20 LOC (`TaskSpec.parentModel`, `TokenUsage.savedCostUSD`, `RunResult.durationMs`, envelope types)
- Each runner: +15 LOC (capture taskStartMs, populate durationMs + savedCostUSD in every helper)
- `packages/mcp/src/cli.ts`: +60 LOC (`computeTimings` / `computeBatchProgress` / `computeAggregateCost` helpers and response envelope wiring)
- Tests: +150 LOC

Total: ~300 LOC plus JSON data. (Up from ~70 LOC for the original rate-table-only scope because savings visibility is now a full sub-feature set.)

---

## 6. progressTrace field — generic post-hoc execution observability

### 6.1 Goal

Attach a bounded, priority-trimmed trace of the progress events from a task's run to the final `RunResult` so the calling agent (human or LLM) can inspect the execution timeline after the fact.

**This is a generic observability feature, not a client-specific workaround.** Long-running delegated tasks need an inspectable post-hoc timeline to answer questions that apply to every delegation workflow:

- *Why did this task take 4 minutes?*
- *Did the worker loop through supervision retries?*
- *Did it escalate across providers?*
- *Where did it stall — reading files, waiting on a tool result, or stuck in re-prompting?*
- *What was the ordered sequence of tool calls vs text emissions?*

`progressTrace` is the low-cost bounded summary that answers all of these from a single inspection of the final result. It is equally useful for:

- **Scripted batch jobs** that never render progress live (CI pipelines, nightly sync tasks, cron-driven analysis)
- **Headless clients** that don't have a UI at all (custom Node SDK consumers, programmatic research agents)
- **Interactive clients** where progress *did* render live but the user wants to go back and review what happened
- **Debugging workflows** where "what did the runner actually do during those 4 minutes" is the question

One specific motivation worth documenting: Claude Code's current MCP client does not render `notifications/progress` into the calling LLM's visible context (verified in brainstorm investigation via a `progress-probe.mjs` test that confirmed the server emits events correctly over the MCP protocol — two events received in 2.3 seconds — but Claude Code's UI does not surface them to the model). For Claude Code users, `progressTrace` is effectively the only post-hoc observability surface available today. But the feature is designed to serve every client and workflow that benefits from post-hoc execution timelines, not just that one client's current limitation. If Claude Code adds live rendering in a future release, `progressTrace` remains valuable as the scrollback-friendly, structured, post-hoc view that callers can inspect programmatically.

### 6.2 Opt-in `TaskSpec` field

```ts
includeProgressTrace?: boolean  // default: false
```

Matches `expectedCoverage`'s opt-in pattern. Zero cost for callers who don't care.

### 6.3 New `RunResult` field

```ts
export interface RunResult {
  // ... existing ...
  progressTrace?: ProgressTraceEntry[]
}

export type ProgressTraceEntry =
  | ProgressEvent
  | {
      kind: '_trimmed';
      droppedCount: number;
      droppedKinds: Partial<Record<ProgressEvent['kind'], number>>;
      capExceededByBoundaryEvents?: boolean;
    };
```

The `_trimmed` marker is a synthetic entry the runner inserts when trimming fires. Not part of the `ProgressEvent` union (runners never emit it via `onProgress`). When the never-drop skeleton alone exceeds the nominal 80-event / 16 KB cap, the marker still appears with `capExceededByBoundaryEvents: true` and `droppedCount: 0`.

### 6.4 Constants

```ts
export const TRACE_MAX_EVENTS = 80;
export const TRACE_MAX_CHARS = 16_384;

export const TRACE_DROP_PRIORITY: Record<ProgressEvent['kind'], number> = {
  text_emission: 1,   // drop first
  tool_call: 2,       // drop second
  turn_start: 100,    // never (effectively)
  turn_complete: 100,
  escalation_start: 100,
  done: 100,
  injection: 100,
};
```

Never-drop tier is absolute: `turn_start`, `turn_complete`, `escalation_start`, `injection`, and `done` are never dropped. The 80-event / 16 KB cap applies to the droppable partition only. Drop tier covers the high-volume, lower-signal events (`text_emission` previews and `tool_call` summaries are already captured in `filesRead` / `toolCalls` / `output`).

### 6.5 Capture mechanism

Each runner's `emit` closure pushes each event into a per-run buffer when `task.includeProgressTrace` is true:

```ts
const shouldCapture = options.includeProgressTrace ?? false;
const traceBuffer: ProgressEvent[] = [];

const emit = (event: ProgressEvent): void => {
  if (shouldCapture) traceBuffer.push(event);
  if (onProgress) onProgress(event);
};
```

No trimming during capture. Trimming happens once at return time in the result helpers. Worst-case memory during a run: a pathological thousands-of-events dispatch is still <1 MB per run.

### 6.6 `trimProgressTrace` function

In `packages/core/src/runners/supervision.ts`:

```ts
export function trimProgressTrace(events: ProgressEvent[]): ProgressTraceEntry[] {
  // Never-drop is absolute. Partition the skeleton first, then budget the
  // droppable partition against whatever event/byte room remains.
  // If the skeleton alone exceeds the nominal cap, keep it anyway and mark
  // `capExceededByBoundaryEvents: true`.
}
```

The implementation keeps the never-drop skeleton intact, then drops only the droppable partition by priority. If the retained droppable partition still does not fit, the fallback keeps the first 10 + last 30 droppable events only. The final trace may still exceed 80 events when the boundary skeleton itself is larger than the nominal cap; in that case the `_trimmed` marker includes `capExceededByBoundaryEvents: true`.

### 6.7 Result helper integration

Each runner's `buildXxx*Result` helpers and inline error/timeout branches gain `{ traceBuffer?: ProgressEvent[]; includeTrace?: boolean }` parameters. When `includeTrace` is true they call `trimProgressTrace(traceBuffer)` and set `result.progressTrace`.

### 6.8 `AttemptRecord` extension

```ts
export interface AttemptRecord {
  // ... existing ...
  progressTrace?: ProgressTraceEntry[]
}
```

The orchestrator's per-attempt loop in `delegate-with-escalation.ts` copies `result.progressTrace` into the `AttemptRecord`. Top-level `result.progressTrace` on the final attempt remains the primary access; `escalationLog[i].progressTrace` lets callers inspect every attempt's trace across an escalation chain.

### 6.9 Response shape impact

Typical 80-event trace at ~16 KB. Three tasks × 16 KB = 48 KB of trace data. Still under the 64 KB pagination threshold. In summary mode, the trace stays on the per-task summary entry (small relative to `output`, whose length drives the threshold decision). If batch + trace combined exceeds the threshold, §3's auto-escape handles it.

### 6.10 Testing

Unit tests in `tests/runners/supervision.test.ts`:

1. Empty input → empty output, no marker
2. Small input under both bounds → returned unchanged, no marker
3. Count-bounded → trims `text_emission` first, preserves boundary events, inserts `_trimmed`
4. Size-bounded → trims by priority until under size
5. Both bounds exceeded → trims until both satisfied
6. 500 text_emissions + 5 turn_starts → all text_emissions dropped, turn_starts kept, marker has `droppedCount: 500`, `droppedKinds: { text_emission: 500 }`
7. Still over bounds after priority drops → fallback to first-10 + last-30 + marker

Runner integration tests:

1. Task with `includeProgressTrace: false` → trace undefined
2. Short happy-path run with trace enabled → trace contains expected sequence in order
3. Supervision retry run with trace enabled → trace includes `injection` event and subsequent `turn_start`/`done`
4. Bounds-exceeding run with trace enabled → trace contains `_trimmed` marker

Orchestrator test:

1. Two-attempt escalation with trace enabled → `escalationLog[0].progressTrace` and `escalationLog[1].progressTrace` both populated; top-level `result.progressTrace` matches final attempt's

### 6.11 Code volume

- `packages/core/src/types.ts`: +25 LOC
- `packages/core/src/runners/supervision.ts`: +80 LOC
- Each runner: +10 LOC capture + 5 LOC per helper × ~5 helpers = +35 LOC
- `packages/core/src/delegate-with-escalation.ts`: +5 LOC (AttemptRecord capture)
- Tests: +150 LOC

Total: ~300 LOC.

---

## 7. `directoriesListed` additive field (item #14)

### 7.1 Goal

Stop mixing file and directory paths in `RunResult.filesRead` while preserving the current `filesRead` semantics for consumers that depend on them. Add a new optional `directoriesListed` field alongside.

### 7.2 New `RunResult` field

```ts
export interface RunResult {
  // ... existing ...
  filesRead: string[]              // unchanged
  filesWritten: string[]           // unchanged
  /** Directories whose entries the worker listed via `listFiles`.
   *  Separate from filesRead — callers that care about file-level activity
   *  continue reading filesRead; callers that want "which folders did the
   *  worker explore" read this. Optional so pre-v0.3.0 result shapes remain
   *  valid; runners always populate it (empty array if no listFiles was
   *  called). */
  directoriesListed?: string[]
  // ...
}
```

### 7.3 `FileTracker` changes

`packages/core/src/tools/tracker.ts` gains one field, one setter, one getter:

```ts
export class FileTracker {
  private reads: string[] = [];
  private writes: string[] = [];
  private dirs: string[] = [];                 // NEW
  private toolCalls: string[] = [];

  trackRead(path: string): void { this.reads.push(path); }
  trackWrite(path: string): void { this.writes.push(path); }
  trackDirectoryList(path: string): void { this.dirs.push(path); }  // NEW

  getReads(): string[] { return [...this.reads]; }
  getWrites(): string[] { return [...this.writes]; }
  getDirectoriesListed(): string[] { return [...this.dirs]; }       // NEW
  getToolCalls(): string[] { return [...this.toolCalls]; }
}
```

### 7.4 `listFiles` tool dual-tracking

`packages/core/src/tools/definitions.ts`'s `listFiles` implementation calls **both** `trackRead` (legacy — preserves `filesRead` behavior) AND `trackDirectoryList` (new clean field):

```ts
async listFiles(dirPath: string): Promise<string[]> {
  assertWithinCwd(dirPath, runnerCwd);
  tracker.trackToolCall(`listFiles(${dirPath})`);
  tracker.trackRead(dirPath);              // legacy
  tracker.trackDirectoryList(dirPath);     // NEW
  // ... unchanged ...
}
```

`readFile` / `writeFile` / `grep` / `glob` are unchanged and do NOT call `trackDirectoryList`.

### 7.5 Runner pass-through

Each runner's result helpers and inline error/timeout branches gain one additional field:

```ts
return {
  // ... existing ...
  filesRead: tracker.getReads(),
  filesWritten: tracker.getWrites(),
  directoriesListed: tracker.getDirectoriesListed(),  // NEW
  toolCalls: tracker.getToolCalls(),
  // ...
};
```

### 7.6 Testing

Extend `tests/tools/tracker.test.ts`:

1. `trackDirectoryList` appends to the directories list
2. `getDirectoriesListed` returns a mutation-safe copy
3. Default state: empty array

Extend `tests/tools/definitions.test.ts`:

1. `listFiles('some/dir')` → both `getReads()` and `getDirectoriesListed()` contain `'some/dir'`
2. `readFile('some/file.ts')` → `getReads()` contains the path; `getDirectoriesListed()` is empty

Runner tests (per runner):

1. Task that calls `listFiles` → `result.directoriesListed` populated
2. Task that calls only `readFile` → `result.directoriesListed === []`
3. Backward compat: `result.filesRead` still contains both file and directory paths

### 7.7 Code volume

- `packages/core/src/types.ts`: +7 LOC
- `packages/core/src/tools/tracker.ts`: +6 LOC
- `packages/core/src/tools/definitions.ts`: +1 LOC
- Runner helpers + inline branches: ~1 LOC × ~18 construction sites = +18 LOC
- Tests: +30 LOC

Total: ~60 LOC.

---

## 8. `delegate_tasks` tool description update (item #6)

### 8.1 Goal

Update the rendered `delegate_tasks` tool description so callers see v0.2+ and v0.3+ additions at tool-call time.

### 8.2 Changes to `TOOL_NOTES`

Extend `packages/mcp/src/routing/render-provider-routing-matrix.ts`'s `TOOL_NOTES` constant with one paragraph per feature area:

- **Response shape (v0.3+)** — `batchId`, `mode`, `responseMode` parameter, threshold-based auto-escape, `get_task_output` fetch. Mention that the threshold is server-configurable.
- **Coverage declaration (v0.3+)** — `expectedCoverage` with `minSections` / `sectionPattern` / `requiredMarkers`. When to use it (enumerable deliverables) and when NOT to (one-shot tasks, conversational work). Lead with non-audit examples.
- **Cost and time visibility (v0.3+)** — `parentModel` opt-in hint, per-task `savedCostUSD` / `durationMs`, batch-level `timings.estimatedParallelSavingsMs` / `batchProgress` / `aggregateCost`. Framed as **estimates**, not accounting.
- **Progress trace (v0.3+)** — `includeProgressTrace` for post-hoc execution observability on long-running tasks. Useful for any workflow (scripted, CI, headless, interactive) that wants a structured timeline of what the runner did.
- **Available tools** — explicit list: `delegate_tasks`, `register_context_block`, `retry_tasks`, `get_task_output`.

### 8.3 Testing

Update existing `tests/routing/render-provider-routing-matrix.test.ts` substring assertions to match the new text. No new tests.

### 8.4 Code volume

- `packages/mcp/src/routing/render-provider-routing-matrix.ts`: +20 LOC

Total: ~25 LOC.

---

## 9. Documentation updates (items #10, #11, #12, #13)

### 9.1 Files touched

- `docs/claude-code-delegation-rule.md` — main changes
- `packages/mcp/README.md` — minor feature bullet updates
- `README.md` (root) — minor version/link updates

### 9.2 Delegation rule: rewrite "Provider Routing" framing

Replace the "free vs paid" framing with workload-shape framing:

> **Route by workload shape, not by price.** The free-vs-paid axis is secondary. The primary question is whether the task's shape fits what a lighter model can actually deliver.
>
> **Cheaper providers sweet spot** (e.g. minimax, claude-haiku): ≤10 structured output sections, ≤50k input-token workload, retrieval tasks, short-form judgment, single-file edits, small test stubs, focused research sub-questions.
>
> **Reasoning providers sweet spot** (e.g. codex, claude-opus): ≥20 structured output sections, ambiguous judgment, security-sensitive review, whole-branch synthesis, unknown-scope exploration, cross-cutting refactors.
>
> **Enumerable-deliverable workloads with many items + large input**: never dispatch as a single task. Either decompose and parallelize (pattern A) or use retrieval/judgment split (pattern B). Typical examples: multi-file refactors (10+ files), test generation across many functions (25+), multi-PR review (15+ PRs), per-endpoint analysis (10+ endpoints), codebase audits against long checklists.

### 9.3 New subsection: "Declaring deliverable coverage"

Under "Writing Delegable Briefs":

> Declare coverage when the deliverable is enumerable. If your brief asks for N discrete outputs, populate `expectedCoverage.requiredMarkers` with the item identifiers or set `minSections` for simpler shapes. The supervision layer will re-prompt the model with specific missing items and classify thin responses as `insufficient_coverage` instead of silently accepting them.
>
> Worked examples across workload shapes:
>
> - **Multi-file refactor**: `requiredMarkers: ["src/auth.ts", "src/user.ts", ..., "src/session.ts"]` — every file path must appear in the output.
> - **Test generation**: `requiredMarkers: ["computeTotal", "validateInput", "formatDate", ...]` — every function name must appear (presumably in a test stub section header).
> - **Multi-PR review**: `requiredMarkers: ["#1234", "#1235", "#1236", ...]` — every PR number must appear.
> - **Per-endpoint analysis**: `requiredMarkers: ["/api/users", "/api/orders", "/api/refunds", ...]` — every endpoint path must appear.
> - **Codebase audit** (internal testing ground): `requiredMarkers: ["1.1", "1.2", ..., "10.2"]` — one per checklist item.
>
> Do NOT declare coverage for one-shot tasks — bug fixes, single implementations, prose explanations, conversational responses, creative writing. The field is opt-in and has no meaning for deliverables you can't enumerate ahead of time. Setting a spurious `minSections: 1` is harmless but pointless.

### 9.4 New section: "Decompose and parallelize enumerable work"

**Pattern A: Decompose and parallelize** — when the work has the shape "do N independent things," dispatch N tasks in one `delegate_tasks` call instead of one big task. The MCP runs them concurrently via `Promise.all`. Use `expectedCoverage.requiredMarkers` per task to pin what "done" looks like per-deliverable, and `batchId` + `retry_tasks` to re-dispatch any individual task that came back thin.

Worked examples (ordered cheapest-to-most-complex):

1. **Multi-file refactor**: "Update import syntax in these 10 files" → 10 tasks, one per file. Each task has a minimal `requiredMarkers: ["<the file's primary export>"]` to catch a worker that silently skipped a file. Parent synthesizes if needed (usually unnecessary — per-file diffs are independent).

2. **Test generation across many functions**: "Write unit tests for these 25 functions" → 5 tasks batched 5 functions each. `requiredMarkers: ["<function1>", "<function2>", ...]` per task. Parent collects test files.

3. **Multi-PR review**: "Review these 15 PRs and flag anything concerning" → 15 tasks in parallel (or batched to your provider's rate limit). `requiredMarkers: ["<PR number>"]` per task. Parent synthesizes top-3 concerns across all PRs.

4. **Per-endpoint analysis**: "Analyze these 10 API endpoints for X" → 10 tasks. `requiredMarkers: ["<endpoint path>"]` per task. Parent builds the cross-endpoint report.

5. **Codebase audit** (internal testing ground example): 3 apps × 10 categories = 30 tasks. Each task audits one category for one app. `requiredMarkers: ["1.1", "1.2", ..., "1.9"]` per Category-1 task, etc.

The audit shape is just one instance of the pattern; the decomposition principle applies to any enumerable-deliverable workload. Parallel dispatch saves wall-clock time — check `timings.estimatedParallelSavingsMs` in the response to see how much.

**Pattern B: Retrieval / judgment split** — when one part of the work is cheap retrieval (grep / list / map) and another part is expensive judgment (synthesize / review / decide), split them across providers. Phase 1: cheap provider does retrieval, emits structured evidence. Phase 2: `register_context_block` the evidence bundle, dispatch judgment to a reasoning provider. The judgment phase never has to re-traverse the source material — it reads the pre-built evidence bundle, dropping input tokens by ~70%.

Worked example:

- Phase 1 (parallel, minimax): "grep -rn for pattern X, Y, Z in these repos; return structured lists of file:line hits" → 15-20 cheap tasks, each producing a small structured output
- Phase 2 (codex): `register_context_block({ id: "evidence-bundle", content: <concatenated retrieval results> })` → one judgment task that takes `contextBlockIds: ["evidence-bundle"]` and produces the final review

This works for code review ("cheap finds changed files, expensive reviews them"), architecture analysis ("cheap maps module structure, expensive reasons about coupling"), large-scale refactor planning ("cheap enumerates call sites, expensive decides migration strategy"), and many other multi-phase workloads.

### 9.5 New subsection: "Measuring savings"

Add a new subsection under "Recommended Practice" explaining the v0.3.0 visibility fields and how the calling agent should surface them back to the user:

> **Measuring what you saved.** The MCP exposes four visibility surfaces so callers can see the UX value of delegation without computing anything themselves. All of them are **estimates** for budgeting and debugging, not accounting numbers — actual parent-model cost would vary with context, tool overhead, and retry patterns; actual serial execution would have different cache and warmup characteristics.
>
> **Per-task cost savings**:
>
> - `result.usage.costUSD` — what this task actually cost on the provider that ran it
> - `result.usage.savedCostUSD` — estimated difference vs running the same token volume on your parent-session model. Only populated when you set `parentModel` on the task spec. Set it. It's the number that tells the user "you just saved $0.12 by delegating this instead of letting opus handle it."
>
> **Batch-level aggregates** (always present on the response envelope):
>
> - `aggregateCost.totalActualCostUSD` — sum of per-task costUSD across the batch
> - `aggregateCost.totalSavedCostUSD` — sum of per-task savedCostUSD (requires `parentModel` on at least one task for any non-zero value)
> - `timings.wallClockMs` — how long the batch actually took
> - `timings.sumOfTaskMs` — sum of individual task durations (what serial execution would have taken)
> - `timings.estimatedParallelSavingsMs` — wall-clock time parallel dispatch bought back vs a hypothetical serial for-loop
> - `batchProgress.completedTasks` / `incompleteTasks` / `failedTasks` — static counts at response time, for the `X/N completed` summary
>
> **Example summary a calling agent can compose directly from one `delegate_tasks` response**:
>
> > Dispatched 5 tasks in parallel. Total cost **$0.031** (estimated savings vs opus: **~$0.42**). Wall-clock: **42s** (estimated serial time saved: **~3m 16s**). **4 of 5 tasks completed successfully**, 1 failed with `api_error` — retry via `retry_tasks({ batchId, taskIndices: [3] })` once the provider is available.
>
> Every number in that summary comes from the response envelope fields without caller-side arithmetic. The `retry_tasks` hint comes from inspecting `results[3].status` and `results[3].error`.

### 9.6 New subsection: "Tightening budgets for weaker models"

Document the per-provider `inputTokenSoftLimit` override:

```json
{
  "providers": {
    "minimax": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "inputTokenSoftLimit": 100000
    }
  }
}
```

Counter-intuitive but small models produce better final answers under tighter budgets. Pair with task-level `maxTurns: 40` when dispatching to weaker providers.

### 9.7 Status handling table update

Add a note under the `incomplete` row covering the new `insufficient_coverage` degenerate kind: supervision-exhausted via the coverage-validation path, specific missing items captured in `escalationLog[i].reason`, remedies (split task, escalate to reasoning, revisit coverage declaration).

### 9.8 MCP README + root README

- Feature bullet: "Declare enumerable-deliverable coverage and get semantic incompleteness detection"
- Feature bullet: "Bounded progress-event traces in final results (`includeProgressTrace`)"
- Tool list: add `get_task_output`
- Link from root README to delegation rule's new patterns section

### 9.9 Code volume

Documentation only. No tests. ~400 lines across three files (up from ~330 because the "Measuring savings" subsection and the expanded pattern docs with multiple non-audit worked examples add material).

---

## 10. Testing rollup, release mechanics, implementation ordering

### 10.1 Test rollup

| Section | New/extended tests |
|---|---|
| §2 Coverage validation | ~16 validateCoverage unit tests (down from ~20 — dropped severity-table cases), ~15 runner integration tests, ~1 captured regression |
| §3 Response pagination | ~20 unit tests (up from ~16 — added configurable-threshold tests), ~5 get_task_output tests, ~1 round-trip integration |
| §4 max_turns fix | ~4 regression tests per runner = 12, ~1 cross-runner parity |
| §5 Cost and timing visibility | ~5 cost tests + ~5 computeSavedCostUSD tests + ~10 aggregate-observability tests (computeTimings, computeBatchProgress, computeAggregateCost) + ~4 runner integration tests for savedCostUSD + durationMs, ~2 schema tests |
| §6 progressTrace | ~7 trimProgressTrace unit tests, ~4 per runner = 12, ~1 orchestrator |
| §7 directoriesListed | ~5 tests across tracker + tool definitions + per runner |
| §8 Tool description | update existing substring assertions |
| §9 Docs | no tests |

**Expected total: ~105 new tests**, bringing the suite from 382 → ~485. No existing tests should break. (Up from ~80 in the pre-delta estimate because cost/timing visibility added ~25 new tests across the new sub-features.)

Critical regressions to not lose sight of:

- Round-2 Fate truncated-ok captured as a test in `tests/runners/supervision-regression.test.ts` — verifies coverage validation catches the exact shape that slipped v0.2.0
- openai-runner `max_turns at 5 turns` regression — mocked continuation needing a tool call, verifies new budget
- v0.2.0 codex abort-path disambiguation continues to pass unchanged

### 10.2 Version plan

- `@zhixuan92/multi-model-agent-core` → **0.3.0**
- `@zhixuan92/multi-model-agent-mcp` → **0.3.0** (depending on `core@^0.3.0`)
- No breaking changes. Everything is additive or opt-in.

### 10.3 Release mechanics

Same two-package flow as v0.2.0:

**Phase A — core release**
1. `npm version minor --workspace @zhixuan92/multi-model-agent-core --no-git-tag-version` → 0.3.0
2. Commit `release(core): bump @zhixuan92/multi-model-agent-core to 0.3.0`
3. Tag `v0.3.0`
4. Dry-run, verify tarball, hand off for 2FA publish
5. Verify `npm view @zhixuan92/multi-model-agent-core version` → 0.3.0

**Phase B — mcp release**
1. Bump mcp's core dep range from `^0.2.0` to `^0.3.0`
2. `npm install` (watch for the nested-node_modules gotcha from v0.2.0 — verify root workspace symlink is intact)
3. Re-run build + tests
4. `npm version minor --workspace @zhixuan92/multi-model-agent-mcp --no-git-tag-version` → 0.3.0
5. Commit `release(mcp): bump @zhixuan92/multi-model-agent-mcp to 0.3.0, repin core to ^0.3.0`
6. Tag `mcp-v0.3.0`
7. Dry-run, verify tarball, hand off for 2FA publish
8. Verify `npm view @zhixuan92/multi-model-agent-mcp version` → 0.3.0
9. Smoke test: `npx -y @zhixuan92/multi-model-agent-mcp@0.3.0 --help`

**Phase C — push**
1. `git push` (two release commits)
2. `git push origin v0.3.0 mcp-v0.3.0` (two tags)

### 10.4 Implementation ordering

Recommended subagent-driven-development task order (the plan will formalize this):

1. **Task 1 — Foundations**: types extensions (`TaskSpec.expectedCoverage`, `TaskSpec.includeProgressTrace`, `TaskSpec.parentModel`, `RunResult.progressTrace`, `RunResult.directoriesListed`, `RunResult.durationMs`, `TokenUsage.savedCostUSD`, `AttemptRecord.progressTrace`, `ProgressTraceEntry`, batch envelope types `BatchTimings` / `BatchProgress` / `BatchAggregateCost`, `insufficient_coverage` `DegenerateKind`). TypeScript compiler catches every RunResult construction site that needs updating. Land as additive, no runner logic yet.
2. **Task 2 — `validateCoverage` + `trimProgressTrace` unit tests**: pure-function additions to `supervision.ts`, fully tested in isolation. Does NOT include severity-table (explicitly dropped).
3. **Task 3 — costUSD rate table + `computeSavedCostUSD`**: `model-profiles.json` rate entries (verify rates against published sources at implementation time), `cost.ts` fallback, new `computeSavedCostUSD` helper, `ModelProfile` schema. Isolated pure functions.
4. **Task 4 — `FileTracker.trackDirectoryList` + `listFiles` dual-tracking + per-runner pass-through**: tracker extension, tool integration, runner wiring.
5. **Task 5 — openai-runner max_turns fix**: raise continuation budget, add `runContinuationTurn` helper, reason precision on all branches.
6. **Task 6 — claude-runner max_turns reason precision**: error propagation on the SDK signal branch.
7. **Task 7 — codex-runner max_turns reason precision**: error propagation on the while-loop-exit branch.
8. **Task 8 — Runner coverage validation integration**: three-runner change. Call `validateCoverage` after `validateCompletion`. Add `insufficient_coverage` to `buildRePrompt`. Integration tests per runner.
9. **Task 9 — Runner durationMs + savedCostUSD capture**: three-runner change. Capture `taskStartMs`, populate `durationMs` on every return path, call `computeSavedCostUSD` with `task.parentModel` when building result helpers. Cheap additive change, good to land early so later tasks can assume the fields exist.
10. **Task 10 — Runner progressTrace capture**: three-runner change. Capture buffer, trim at return, orchestrator `AttemptRecord` propagation.
11. **Task 11 — Pagination + `get_task_output` + configurable threshold**: batch cache extension to store `RunResult[]`, `delegate_tasks` response mode logic, new tool registration, `largeResponseThresholdChars` resolution (env var > config > option > default), integration tests including threshold configurability.
12. **Task 12 — Envelope aggregates (`timings`, `batchProgress`, `aggregateCost`)**: implement `computeTimings` / `computeBatchProgress` / `computeAggregateCost` pure helpers in `packages/mcp/src/cli.ts`, wire into both `buildFullResponse` and `buildSummaryResponse`, wall-clock timing capture in the handler. Integration tests that dispatch through the stubbed runTasks and verify the envelope fields.
13. **Task 13 — Tool description update**: extend `TOOL_NOTES` with all v0.3.0 additions.
14. **Task 14 — Documentation**: delegation rule rewrite, "Measuring savings" subsection, "Decompose and parallelize" pattern docs, README updates.
15. **Task 15 — Release**: version bumps, tags, publish via the two-phase flow in §10.3.

### 10.5 Blast radius summary

| Layer | Files touched | Breaking changes |
|---|---|---|
| `packages/core/src/types.ts` | 1 | none (additive — ~8 new optional fields / types) |
| `packages/core/src/runners/supervision.ts` | 1 | none (additive — `validateCoverage`, `trimProgressTrace`, new DegenerateKind) |
| `packages/core/src/runners/openai-runner.ts` | 1 | none (behavior fix + additive fields + durationMs/savedCostUSD/progressTrace capture) |
| `packages/core/src/runners/claude-runner.ts` | 1 | none (reason precision + additive fields + durationMs/savedCostUSD/progressTrace capture) |
| `packages/core/src/runners/codex-runner.ts` | 1 | none (reason precision + additive fields + durationMs/savedCostUSD/progressTrace capture) |
| `packages/core/src/cost.ts` | 1 | none (additive fallback + new `computeSavedCostUSD`) |
| `packages/core/src/routing/model-profiles.ts` | 1 | schema additions (optional rate fields) |
| `packages/core/src/model-profiles.json` | 1 | data additions (published rates per family) |
| `packages/core/src/delegate-with-escalation.ts` | 1 | `AttemptRecord` additive field |
| `packages/core/src/tools/tracker.ts` | 1 | additive `trackDirectoryList` method |
| `packages/core/src/tools/definitions.ts` | 1 | additive tracker call in `listFiles` |
| `packages/core/src/index.ts` | 1 | re-exports for new types |
| `packages/mcp/src/cli.ts` | 1 | new `get_task_output` tool, response mode logic, configurable threshold resolution, envelope aggregate helpers, batch cache stores results |
| `packages/mcp/src/routing/render-provider-routing-matrix.ts` | 1 | `TOOL_NOTES` additions |
| Tests | ~12 files | +105 new tests, 0 broken |
| Docs | 3 files | ~400 lines total |
| **Total** | **~30 files** (14 code + ~12 test + 3 docs + 1 `model-profiles.json` counted under code) | **0 breaking** |

Largest single-file change: `packages/mcp/src/cli.ts` (~180 LOC added for pagination + configurable threshold + envelope aggregates + new `get_task_output` tool), narrowly beating `packages/core/src/runners/openai-runner.ts` (~80 LOC for the max_turns continuation fix + per-runner duration/savings/progress capture). Nothing approaches the size of Task 1 or Task 4 from v0.2.0.

---

## 11. Appendix: resolved open questions from brainstorming

1. **Q1 — scope shape**: "focused/medium release" (scope B) with two corrections applied during design: progress-events item investigation resolved via live probe (H3 confirmed — client-side, not server bug), `directoriesListed` additive only (no breaking `filesRead` change).
2. **Q2 — progress-events investigation shape**: Option C (investigate inline in this brainstorm). Investigation outcome: server-side bridge works end-to-end, confirmed via `progress-probe.mjs` receiving 2 events in 2.3 seconds against a live built server. The visibility gap is Claude Code client-side; server-side mitigation is the `progressTrace` field in §6. Post-review, §6's framing was updated to present `progressTrace` as generic post-hoc execution observability, not a client-specific workaround.
3. **Q3 — coverage validation API shape**: **Final design: generic-only (`minSections` + `sectionPattern` + `requiredMarkers`).** An earlier draft included `selfConsistencySummary: 'severity-table' | false` as a growable enum; this was **dropped entirely during codex-led design review** as audit-specific. The severity-table mode hardcoded one markdown table header shape, fixed severity categories, and specific body markers that do not generalize to any of the representative public workloads (multi-file refactor, test generation, PR review, per-endpoint analysis, research). It belongs in user documentation as a workload-specific pattern, not in core supervision.
4. **Q4 — pagination design**: Option C hybrid (explicit + auto-escape), default mode `'auto'`, summary shape with `outputLength` + `outputSha256` + `_fetchWith` hint. **Threshold refinement from design review**: the initial spec hardcoded 65_536 bytes; the final design makes the threshold **server-configurable** via env var > config file > `buildMcpServer` option > default precedence chain, so consumers with clients that handle larger responses natively aren't penalized by Claude Code's inline-rendering limit.
5. **Q5 — progressTrace shape**: per-task trace (not per-batch), with the 80-event / 16 KB cap applied to droppable events only. Boundary events (`turn_start`, `turn_complete`, `escalation_start`, `injection`, `done`) are preserved in full, `text_emission` and `tool_call` are dropped first, and `_trimmed.capExceededByBoundaryEvents` flags the rare case where the boundary skeleton alone exceeds the nominal cap. Opt-in via `includeProgressTrace`.
6. **Design review addition: cost and timing visibility** — the initial spec only had the rate-table fallback (§5 original scope). User feedback that "people should be aware how much they saved by using our tool" led to expanding §5 with five new sub-features: `parentModel`/`savedCostUSD` (estimated cost savings vs declared parent model), `durationMs` per task, `timings.estimatedParallelSavingsMs` (estimated wall-clock saved by parallel dispatch vs hypothetical serial), `batchProgress` (static completion counts), and `aggregateCost` (batch-level totals). All framed as **estimates**, not accounting, per codex review.
7. **Design review addition: batchProgress as static snapshot only** — codex's review recommended a richer progress concept including live states (`queued` / `running` / `waiting_for_tools` / `supervision_retry` / `escalating`). These were **scoped down** to the static final-response snapshot only. Rationale: live states require a live delivery channel the calling LLM can observe mid-flight, and Claude Code's MCP client does not currently surface progress notifications live. Adding the infrastructure now would ship a state machine whose payoff depends on a client-side fix outside this repo. Deferred until either Claude Code's rendering improves or a companion `get_batch_status(batchId)` poll tool is designed.
8. **Smaller items committed without explicit questioning**: max_turns fix applies to openai-runner only (verified via grep); reason precision applies to all three runners; `insufficient_coverage` is a new `DegenerateKind` (not a top-level `RunStatus`); escalation behavior unchanged (`insufficient_coverage` flows through the existing salvage-tier selection as real content because `outputIsDiagnostic: false`).

---

## 12. Appendix: link to v0.2.0 reference

This spec is layered on top of v0.2.0 (`docs/superpowers/specs/2026-04-10-subagent-completion-supervision-design.md` and `docs/superpowers/plans/2026-04-10-subagent-completion-supervision-plan.md`). The four-layer architecture (prevention → recovery → salvage → escalation), `RunStatus` values, `AttemptRecord` shape, and the context-blocks / `batchId` / `retry_tasks` infrastructure from v0.2.0 are all prerequisites. Nothing in v0.3.0 replaces or rewrites v0.2.0 behavior — it extends.

Every v0.2.0 test continues to pass unchanged. The round-2 post-mortem that drove v0.3.0 is linked in §1.1.
