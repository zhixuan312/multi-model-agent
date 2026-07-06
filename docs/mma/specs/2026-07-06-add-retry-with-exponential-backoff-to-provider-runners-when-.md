---
version: 1
updated_at: 2026-07-06
---

# Add Retry With Exponential Backoff To Provider Runners On 429 And 503

## Context

### Background
Multi Model Agent executes worker turns through provider-specific runner sessions in [`packages/core/src/providers/claude-session.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/claude-session.ts) and [`packages/core/src/providers/codex-cli-session.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/codex-cli-session.ts). Those sessions are created by [`packages/core/src/providers/claude.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/claude.ts) and [`packages/core/src/providers/codex.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/codex.ts), then invoked by the unified two-phase pipeline in [`packages/core/src/unified/two-phase-pipeline.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/unified/two-phase-pipeline.ts).

Each provider session receives a hard per-task wall-clock deadline through `SessionOpts.wallClockDeadline`, defined in [`packages/core/src/types/run-result.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/types/run-result.ts), and is already responsible for provider-specific lifecycle concerns such as abort handling, subprocess shutdown, token accounting, and diagnostic event emission through the plain log event system in [`packages/core/src/events/plain-log-entry.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/events/plain-log-entry.ts).

Today, transient upstream failures from Anthropic-compatible and OpenAI-compatible backends are surfaced as immediate task failures. That behavior is acceptable for permanent request defects, but it is a poor fit for temporary overload and rate-limit responses that often clear within seconds. The codebase already contains a deadline-aware exponential backoff implementation in [`packages/core/src/research/web-search.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/research/web-search.ts), which provides an existing precedent for jittered retries under a fixed time budget.

## Problem

A single upstream `429 Too Many Requests` or `503 Service Unavailable` response currently terminates an otherwise valid worker turn, causing the entire task or review phase to fail even when a short retry would have succeeded. This wastes prior work in the active session, increases operator re-dispatch load, and lowers effective task completion rate under provider congestion.

## Goals & Requirements

### Goals
1. Recover automatically from transient upstream throttling and overload in both Claude and Codex provider runners.
2. Apply a consistent exponential backoff policy with bounded jitter so retries spread out instead of stampeding the upstream API.
3. Preserve immediate failure behavior for permanent client-side request errors.
4. Keep retry behavior inside the existing per-task wall-clock and cost-accounting model.

### Functional requirements
- FR-1. Provider runners must retry failed upstream calls when the upstream status code is `429` or `503`.
- FR-2. The retry schedule must use exponential base delays of `1000 ms`, `2000 ms`, and `4000 ms`, each adjusted by jitter in the inclusive range `0.75x` to `1.25x`.
- FR-3. The runner must perform at most `3` retry attempts after the initial failed attempt, for a maximum of `4` total upstream call attempts per worker turn.
- FR-4. When the upstream response includes a `Retry-After` header, the runner must wait for the header-derived delay instead of the computed exponential delay for that retry, provided the header value is valid.
- FR-5. Non-retriable client errors, defined as all `4xx` responses except `429`, must fail immediately without any retry delay.
- FR-6. Each scheduled retry must emit a diagnostic event containing the provider, attempt number, triggering status code, selected delay, and whether the delay came from `Retry-After` or exponential backoff.
- FR-7. Retry logic must not sleep past `SessionOpts.wallClockDeadline`; if the remaining wall-clock budget cannot accommodate the next retry delay, the runner must stop retrying and return the original failure.
- FR-8. Retry attempts must execute inside the existing provider session and cost-accounting flow; no new budget type, retry-specific quota, or cross-provider failover path may be introduced by this change.

### Scope

#### In scope
- Shared retry-with-backoff logic used by both provider runner implementations.
- Retry classification for upstream `429` and `503` failures surfaced by Claude SDK calls and Codex CLI/API-backed calls.
- `Retry-After` header parsing and precedence over computed backoff when valid.
- Deadline-aware delay capping and retry suppression when the remaining wall-clock budget is insufficient.
- Diagnostic logging for each scheduled retry attempt.
- Unit and provider-level tests covering retryable, non-retryable, and deadline-constrained behavior.

#### Out of scope
- Circuit breakers, adaptive concurrency control, or global rate-limit coordination across tasks.
- Provider fallback from Claude to Codex or from Codex to Claude after retry exhaustion.
- Per-model, per-project, or per-route retry budgets separate from existing task-level limits.
- Retrying failures that do not expose an upstream `429` or `503` classification.
- Changing reviewer, pipeline, or batch orchestration semantics outside the provider runner boundary.
- Modifying pricing, token billing, or top-level task timeout defaults.

### Constraints
- The implementation must honor the existing task wall-clock contract supplied through `SessionOpts.wallClockDeadline`; it must never extend the deadline.
- Retry behavior must work for both providers currently supported by the repo: Claude through `ClaudeSession` and Codex through `CodexCliSession`.
- The design must preserve current immediate-failure behavior for malformed requests and authorization failures, especially `400`, `401`, and `403`.
- The design must fit into the existing diagnostics surface, which uses typed provider event names in `packages/core/src/events/plain-log-entry.ts`.
- The change must keep the provider session abstraction stable for callers in the unified pipeline; callers must not need new retry orchestration code.
- The implementation should reuse the repo’s established deadline-aware jittered backoff pattern where practical, to reduce behavioral drift across subsystems.

### Success metrics

| Metric | Target | How measured |
|---|---|---|
| Retry recovery rate for transient provider throttling | Greater than 90% of retryable `429` responses complete successfully within the same task run | Diagnostic retry events joined with terminal task outcomes in logs |
| False-retry rate for non-retriable `4xx` responses | 0 retries for `400`, `401`, `403`, and other `4xx` statuses except `429` | Unit and provider-level tests |
| Deadline safety | 0 cases where retry sleep extends execution beyond the supplied `wallClockDeadline` | Unit tests with injected clocks and existing timeout telemetry |
| Diagnostic coverage | 100% of scheduled retries emit one diagnostic event | Unit tests against provider event emission |

## Alternatives

### Driving factors
1. Minimize wasted work after a transient upstream failure.
2. Keep retry decisions close to the provider-specific error shape.
3. Preserve existing wall-clock and cost-accounting boundaries.
4. Limit implementation complexity and regression surface.
5. Produce diagnostics precise enough to debug provider throttling behavior.

### Options

#### Option A: Runner-level retry via a shared helper
Implement a shared retry wrapper used inside `ClaudeSession.send()` and `CodexCliSession.send()`, with provider-specific error classification adapters.

Pros:
- Retries only the failed upstream call instead of replaying an entire pipeline phase.
- Keeps `wallClockDeadline` enforcement local to the code that already owns subprocess and SDK lifetimes.
- Reuses current provider diagnostics paths.

Cons:
- Requires provider-specific error parsing for two different execution models.
- Adds a small amount of complexity to both runner implementations and the provider-event schema.

#### Option B: Pipeline-level retry of the whole implementer or reviewer phase
Teach the unified pipeline to re-run a failed phase when a provider reports a retryable failure.

Pros:
- Centralizes retry logic in one orchestration layer.
- Avoids changes inside provider sessions.

Cons:
- Re-runs the entire phase, including repeated prompt assembly and duplicated work.
- Makes it harder to distinguish retryable upstream failures from ordinary runner failures.
- Increases cost and wall-clock waste substantially.

#### Option C: Provider-specific ad hoc retry logic with no shared helper
Add separate retry loops directly in `ClaudeSession.send()` and `CodexCliSession.send()` without a common abstraction.

Pros:
- Lower short-term abstraction overhead.
- Each provider can tune behavior independently.

Cons:
- Duplicates retry policy and increases drift risk.
- Makes tests and diagnostics harder to keep consistent.
- Raises future maintenance cost for any retry-policy change.

### Comparison

| Factor | Option A: Shared runner helper | Option B: Pipeline retry | Option C: Duplicated runner logic |
|---|---|---|---|
| Granularity | Retries only the failed upstream call | Replays an entire phase | Retries only the failed upstream call |
| Wasted work | Low | High | Low |
| Error-shape awareness | High | Medium | High |
| Deadline control | Strong, local to session deadline | Indirect, spread across orchestration | Strong, but duplicated |
| Diagnostics precision | High | Medium | Medium |
| Implementation complexity | Moderate | High | Moderate |
| Long-term maintainability | High | Medium | Low |

## Decision Records

1. Decision: Implement runner-level retry through a shared helper used by both provider sessions.
Rationale: The session layer already owns upstream call execution, provider-specific error shapes, and the hard wall-clock deadline. Retrying at this layer minimizes wasted work and avoids phase-level replay.

2. Decision: Retry only on upstream status codes `429` and `503`.
Rationale: These statuses represent transient throttling and overload conditions. Other `4xx` statuses usually indicate a permanent request defect or permission problem and should fail fast to preserve clarity.

3. Decision: Use exactly three retry delays based on `1 s`, `2 s`, and `4 s`, with `±25%` jitter.
Rationale: This policy is simple, bounded, and aligned with the design input. It provides quick recovery for short provider blips while limiting extra latency under persistent failure.

4. Decision: Respect `Retry-After` when valid and parse both delta-seconds and HTTP-date forms.
Rationale: The upstream service has the most accurate local view of its recovery window. Supporting both valid header encodings prevents unnecessary early retries.

5. Decision: Stop retrying when the next delay would exceed the remaining wall-clock budget.
Rationale: The task deadline is a hard contract. Retrying beyond the deadline would violate the runtime’s bounded execution guarantees and could mask timeout ownership.

6. Decision: Record retry scheduling through provider diagnostic events, not through a new top-level telemetry subsystem.
Rationale: The repo already has a typed provider-event pathway for session-level diagnostics. Extending that system is smaller and keeps retry observability near the runner implementation.

## Technical Design

### Current state

At HEAD:

- [`packages/core/src/providers/claude.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/claude.ts) creates `ClaudeSession` and adds no retry behavior.
- [`packages/core/src/providers/claude-session.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/claude-session.ts) performs a single `query()` call per `send()`. If the SDK throws, the method emits `claude_error`, closes the active query, and rethrows immediately.
- [`packages/core/src/providers/codex.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/codex.ts) creates `CodexCliSession` and adds no retry behavior.
- [`packages/core/src/providers/codex-cli-session.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/providers/codex-cli-session.ts) manages a single codex CLI subprocess per `send()`, enforces `wallClockDeadline` through `armGuards()`, and returns or throws based on the first attempt outcome. There is no retry branch for upstream HTTP status failures.
- [`packages/core/src/types/run-result.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/types/run-result.ts) already includes `SessionOpts.wallClockDeadline`, `abortSignal`, and a session-local bus surface, so the runtime already has the primitives needed for deadline-aware retries and diagnostic emission.
- [`packages/core/src/events/plain-log-entry.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/events/plain-log-entry.ts) maintains a closed list of provider event names. Adding retry diagnostics requires extending that list.
- [`packages/core/src/research/web-search.ts`](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/79a7fff4/packages/core/src/research/web-search.ts) already demonstrates the repository’s accepted pattern for exponential backoff with jitter and deadline-capped sleeping.

### Proposed design

#### Architecture

Add a shared retry module under `packages/core/src/providers/` that wraps a single upstream call attempt and is invoked by both `ClaudeSession.send()` and `CodexCliSession.send()`.

The flow is:

1. Provider session constructs a single-attempt function that performs the current upstream call exactly once.
2. Provider session passes that function plus a provider-specific error classifier and diagnostic emitter into the shared retry helper.
3. The helper executes the attempt.
4. On success, the helper returns the turn result unchanged.
5. On failure, the helper classifies the error.
6. If the error is non-retryable, retry budget is exhausted, the status is not `429` or `503`, or the wall-clock budget cannot fit the next delay, the helper rethrows the original failure.
7. If the error is retryable, the helper computes the wait duration from `Retry-After` when valid, otherwise from the exponential backoff policy with jitter, emits one diagnostic event, sleeps, and runs the next attempt.

This design keeps the retry decision inside the provider session boundary while centralizing the policy math and deadline checks.

#### Interfaces / APIs

The implementation must introduce a shared helper with an explicit contract equivalent to the following:

```ts
export type RetryableProvider = 'claude' | 'codex';

export interface RetryClassification {
  statusCode: number;
  retryAfterMs: number | null;
  reason: 'status_429' | 'status_503';
}

export interface ProviderRetryEvent {
  provider: RetryableProvider;
  attempt: number;
  maxRetries: number;
  statusCode: 429 | 503;
  delayMs: number;
  source: 'retry_after' | 'exponential_backoff';
}

export interface RetryWithBackoffArgs<T> {
  provider: RetryableProvider;
  wallClockDeadline: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  classify(error: unknown): RetryClassification | null;
  emit(event: ProviderRetryEvent): void;
  runAttempt(): Promise<T>;
}

export async function retryWithBackoff<T>(args: RetryWithBackoffArgs<T>): Promise<T>;
```

Required helper behavior:

- `maxRetries` is fixed at `3`.
- Base delays are fixed at `[1000, 2000, 4000]`.
- Jitter formula is `baseDelayMs * (0.75 + random() * 0.5)`.
- `Retry-After` parsing must accept:
  - integer delta-seconds, converted to milliseconds
  - HTTP-date, converted to `max(0, parsedDateMs - Date.now())`
- Invalid or negative `Retry-After` values must be ignored in favor of exponential backoff.
- The helper must compare the chosen delay to `wallClockDeadline - Date.now()`. If the remaining budget is `<= 0` or less than the chosen delay, the helper must stop retrying and rethrow the original error.

Provider integration requirements:

- `ClaudeSession.send()` must wrap the `query()` execution path with the shared helper rather than implementing a second retry loop directly.
- `CodexCliSession.send()` must wrap the single subprocess attempt path with the same helper.
- Each provider must supply a local `classify(error)` adapter that extracts an upstream HTTP status code and `Retry-After` value from the provider’s error surface.
- Retry logic must only wrap the upstream call. It must not duplicate `this.turns += 1` or emit duplicate “turn started” events for retries of the same worker turn.

Diagnostic API changes:

- `packages/core/src/events/plain-log-entry.ts` must extend `PROVIDER_EVENT_NAMES` with `claude_retry_scheduled` and `codex_retry_scheduled`.
- Each retry event payload must include primitive fields:
  - `attempt`
  - `maxRetries`
  - `statusCode`
  - `delayMs`
  - `source`
  - `taskId` when present
  - `taskIndex` when present

#### Data model

No persistent storage schema changes are required.

In-memory data introduced by this change is limited to:

- Retry policy constants:
  - `MAX_RETRIES = 3`
  - `BASE_BACKOFF_MS = [1000, 2000, 4000]`
  - `JITTER_RATIO = 0.25`
- Per-attempt classification data:

```ts
type RetryClassification = {
  statusCode: 429 | 503;
  retryAfterMs: number | null;
  reason: 'status_429' | 'status_503';
};
```

- Per-retry diagnostic payload:

```ts
type ProviderRetryEvent = {
  provider: 'claude' | 'codex';
  attempt: 1 | 2 | 3;
  maxRetries: 3;
  statusCode: 429 | 503;
  delayMs: number;
  source: 'retry_after' | 'exponential_backoff';
};
```

No migration is needed because the new data is ephemeral and log-only.

#### Implementation details

1. Shared helper placement
Rationale: Policy should exist in one place to avoid drift.
Implementation: Create a provider-local utility module such as `packages/core/src/providers/retry-with-backoff.ts` and keep it independent of Claude- or Codex-only types.

2. Claude error classification
Rationale: `ClaudeSession.send()` currently rethrows raw SDK errors, so retry decisions must be derived from the thrown error object.
Implementation: Add a narrow classifier that inspects common status-bearing fields such as `status`, `statusCode`, and response/header containers if present. Only `429` and `503` should produce a `RetryClassification`; all other shapes return `null`.

3. Codex error classification
Rationale: Codex errors may surface through subprocess output or wrapped API errors rather than a first-class HTTP response object.
Implementation: Add a Codex-specific classifier that inspects normalized error metadata first, then conservative message parsing as a fallback only when it can unambiguously identify upstream `429` or `503`. Ambiguous failures remain non-retryable.

4. Delay selection
Rationale: The design requires deterministic policy with bounded randomness.
Implementation:
- Attempt 1 retry uses base `1000 ms`
- Attempt 2 retry uses base `2000 ms`
- Attempt 3 retry uses base `4000 ms`
- Jitter is multiplicative in the inclusive band `75%` to `125%`
- `Retry-After` overrides the computed jittered delay only for the current retry

5. Deadline handling
Rationale: The task deadline is a hard ceiling already enforced elsewhere in the runtime.
Implementation: Before each sleep, compute `remainingMs = wallClockDeadline - Date.now()`. If `remainingMs <= 0` or `delayMs > remainingMs`, abort retrying and surface the original failure. The helper must not silently shorten the delay and then retry early; early retries would violate the server’s explicit backoff guidance in `Retry-After`.

6. Session behavior
Rationale: Retries are still part of the same worker turn.
Implementation: Keep a single `send()` call contract externally. Internal retries may create multiple provider attempt executions, but callers still observe one turn result or one final thrown error.

7. Cost accounting
Rationale: The feature must not invent new charging semantics.
Implementation: Each retried provider attempt continues to incur whatever provider usage and wall-clock cost it already would. No separate retry ledger is added. This preserves current cost telemetry semantics automatically.

8. Event emission
Rationale: Operators need to see retry behavior during incidents.
Implementation: Emit the retry diagnostic immediately before sleeping, once per scheduled retry. Do not emit for the initial failed attempt or for retries that are skipped because the deadline budget is insufficient.

### Failure handling

- If the upstream error cannot be classified as an HTTP `429` or `503`, the runner must fail exactly as it does today.
- If `Retry-After` is malformed, negative, or unparseable, the helper must ignore it and fall back to exponential backoff.
- If retry budget is exhausted after the third retry attempt, the runner must rethrow or return the final failure exactly once.
- If the task abort signal fires while sleeping between retries, the sleep must terminate promptly and the session must surface the same abort/timeout behavior already used by the runner.
- If the provider session closes or subprocess teardown fails during retry handling, existing close-path best-effort cleanup rules remain in force.
- If a diagnostic event cannot be emitted, that must not block the retry itself; the retry path should preserve the current best-effort behavior of provider event emission.

### Impact

Breaking changes:

- None to public HTTP APIs or task payload schemas.
- Internal provider diagnostic event schema expands with two new event names, which is a backward-compatible additive change for log consumers that accept unknown event variants only after the schema file is updated in the same release.

Operational impact:

- Worker turns that hit transient `429` or `503` conditions may now take up to roughly the original attempt duration plus `1 s + 2 s + 4 s` backoff, subject to jitter and deadline limits.
- Some tasks that previously failed immediately will now succeed without re-dispatch.
- During sustained provider outages, failure latency may increase modestly because the runtime will spend up to three retries before surfacing the final error, unless the deadline budget prevents further waiting.

Rollout plan:

1. Land the shared helper and provider-session integration.
2. Extend provider event names and tests in the same change.
3. Observe diagnostic logs for retry volume and recovered tasks.
4. If provider-specific misclassification appears, tighten the classifiers without changing the shared retry policy.

## Testing Plan

### Test strategy

The test suite must prove four things:

1. Retry happens only for transient upstream statuses `429` and `503`.
2. Delay selection follows the specified backoff policy, including `Retry-After` override behavior.
3. Retry never violates the existing task wall-clock deadline.
4. Every scheduled retry is observable through diagnostics, while non-retryable failures still fail immediately.

### Technical details

| Layer | What is tested | Tool | Coverage target |
|---|---|---|---|
| Unit | Shared helper retries `429` and `503`, computes jittered delays, respects `Retry-After`, stops at 3 retries, and stops when deadline budget is insufficient | `vitest` unit tests with injected `sleep` and `random` | 100% branch coverage for helper decision branches |
| Provider unit | Claude classifier maps retryable and non-retryable error shapes correctly | `vitest` in `tests/providers/` | Cover known retryable status shapes and at least one malformed header case |
| Provider unit | Codex classifier maps retryable and non-retryable error shapes correctly | `vitest` in `tests/providers/` | Cover status extraction from normalized error metadata and ambiguous fallback rejection |
| Provider integration | `ClaudeSession.send()` emits one retry diagnostic per scheduled retry and returns success when a later attempt succeeds | `vitest` with mocked provider call path | Cover 429 recovery and 400 immediate failure |
| Provider integration | `CodexCliSession.send()` emits retry diagnostics, retries 503, and preserves deadline guard semantics | `vitest` with mocked subprocess attempt path | Cover 503 recovery and deadline-blocked retry |

## Acceptance Criteria

1. [ ] AC-1.1: When a Claude or Codex upstream call fails with status `429`, the same worker turn is retried automatically without requiring pipeline-level re-dispatch.
2. [ ] AC-1.2: When a Claude or Codex upstream call fails with status `503`, the same worker turn is retried automatically without requiring pipeline-level re-dispatch.
3. [ ] AC-2.1: Retry delays use exponential bases of `1000 ms`, `2000 ms`, and `4000 ms`, each jittered within the inclusive `75%` to `125%` range when `Retry-After` is absent or invalid.
4. [ ] AC-3.1: The runtime performs no more than `3` retries after the initial failed attempt, for a maximum of `4` total attempts per turn.
5. [ ] AC-4.1: A valid `Retry-After` header overrides the computed exponential delay for that retry and is honored by both provider runners.
6. [ ] AC-5.1: A `400` response fails immediately with no retry.
7. [ ] AC-5.2: A `401` response fails immediately with no retry.
8. [ ] AC-5.3: A `403` response fails immediately with no retry.
9. [ ] AC-6.1: Every scheduled retry emits exactly one diagnostic provider event containing provider, attempt, status code, delay, and delay source.
10. [ ] AC-7.1: If the remaining wall-clock budget is insufficient for the next retry delay, no additional retry is attempted and the original failure is surfaced.
11. [ ] AC-8.1: Retry attempts consume the existing provider execution path and require no new task-level budgeting or cross-provider orchestration changes.
