/**
 * Review-specific implementer criteria.
 *
 * REVIEW'S PURPOSE — read this before adding categories.
 * mma-review is the pre-merge gate. The maintainer accepting your verdict
 * will NOT re-investigate before pressing merge — your output is treated
 * as authoritative. The success criterion is:
 *
 *   "After fixes, will the merge be safe, correct, and maintainable —
 *    such that a regression is unlikely to ship?"
 *
 * That criterion makes a finding load-bearing. A nit that doesn't change
 * whether the merge is safe is low-priority no matter how clean the
 * suggested rewrite reads. A cross-file ripple that breaks a caller
 * not in the diff is the audit-equivalent of an unimplementable fix —
 * load-bearing even though the named file looks fine in isolation.
 *
 * Review examines source code in named files against a focus area
 * (security/correctness/performance/style). Findings should be
 * line-quotable — that's the natural shape of code defects — but
 * cross-file findings backed by call-site references are also valid.
 */

/**
 * The orientation block. Goes at the TOP of every review prompt.
 *
 * This is the load-bearing addition. Without an explicit purpose
 * statement, workers default to "find issues in this file" — which
 * produces line-by-line proofreading and misses the cross-file rippe,
 * test-gap, and implicit-contract findings that actually block merges.
 */
export const REVIEW_PURPOSE_ORIENTATION = [
  'Why this review exists:',
  'mma-review is the pre-merge gate. The maintainer accepting your verdict will NOT re-investigate before merging — your verdict is treated as authoritative. A miss here ships to production.',
  '',
  'Your job is to find anything that would make the merge unsafe, including issues that look fine in the named files in isolation:',
  '- a changed function with no test (or with a test that does not exercise the change)',
  '- a changed signature whose direct callers (visible in the named files or via grep on the symbol) were not updated',
  '- a change that introduces a new edge case (null/empty/timeout/error path) the code does not handle',
  '- a race or concurrency hazard the change exposes (shared state mutation, missing lock, await-after-check pattern)',
  '- a resource leak the change introduces (unclosed handle, untracked promise, file descriptor not freed)',
  '- a backward-compatibility break in a public API or wire schema',
  '- a security regression (auth bypass, injection, untrusted input flowing to a sink, data exposure)',
  '- a performance regression (N+1 query, unbounded loop, blocking I/O on a hot path, unnecessary deep clone)',
  '- an implicit-contract assumption — the change relies on the caller doing X but the contract does not state X',
  '- a pre-existing bug entangled with the change (NOT a finding against this diff — separate cleanly)',
  '',
  'A finding that points at any of these is high-value EVEN IF the prose of the change reads cleanly. Conversely, a stylistic nit that does not change merge safety is low-priority no matter how clean the suggested rewrite reads.',
  '',
  'The completion test: would a maintainer who reads only your review and the diff (not the surrounding code) understand which changes are required, why each is required, and where each lives — well enough to apply the fix and re-merge?',
].join('\n');

export const EVIDENCE_RULE_REVIEW = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Cite `file:line` (or `file:line-line` for a span) where the issue lives.',
  '- Quote the exact code excerpt or command output that demonstrates the issue. Do not paraphrase — quote.',
  '- For CROSS-FILE findings (a change in named file A breaks a caller B), cite both: the line in A that triggers the break, AND the call site in B that breaks. If B is not in the named files but is reachable via grep on the changed symbol, name it explicitly. Cross-file findings backed by call-site references are FULLY VALID — do not drop them as out-of-scope.',
  '- For TEST-GAP findings, name the test file you would expect to cover the change AND quote the diff line that has no test coverage. If no test file exists for the changed area, that itself is the finding.',
  '- For IMPLICIT-CONTRACT findings, quote the line in the named file that depends on the assumption AND name the contract source (the public docstring, the type, the README) that does not state the assumption.',
  '- If you cannot quote evidence in one of these forms, do NOT raise the finding. Note "investigation needed" in your summary instead.',
].join('\n');

export const SCOPE_RULE_REVIEW = [
  'Scope:',
  '- The named files. Behavior of direct callers/callees can be referenced when visible in those files.',
  '- Cross-file ripples ARE in scope when the changed symbol is searchable: if the named files change a public function, look for its call sites in the rest of the repo and flag any caller that would break. This is the highest-value cross-file work for a code review.',
  '- Test gaps ARE in scope: if the named files change behavior and a test file is the natural sibling (e.g. `foo.ts` → `tests/foo.test.ts`), check whether the test exercises the change.',
  '- Out of scope: speculation about untouched files unrelated to the diff; doc/spec issues (those belong in an audit, not a review); style nits when the focus area is security/correctness/performance.',
  '- Pre-existing bugs (the diff did not introduce them) belong in their own backlog item, not in this review. Note them in a "Pre-existing — out of scope" section if you spot them, but DO NOT mix them into the merge-blocking findings.',
].join('\n');

/**
 * The failure-mode taxonomy for code reviews.
 *
 * Without this block, workers default to line-by-line proofreading of
 * the named file and miss cross-file ripples, test gaps, and
 * implicit-contract regressions — the findings that actually block
 * merges. The 10 categories below are what a careful maintainer would
 * scan for before pressing merge.
 */
export const CODE_REVIEW_FAILURE_MODES = [
  'Look for these kinds of issues — applicable to ALL code reviews regardless of focus. The focus area (security/correctness/performance/style) tells you which lens to weight, but every code review should sweep the full taxonomy:',
  '',
  '1. TEST GAP — the diff changes behavior, but no test exercises the change. Either: no test file exists, OR the test file exists but the changed branch is not covered. **Always check for the natural sibling test file when reviewing source-code changes.**',
  '2. CROSS-FILE RIPPLE — a changed signature, return shape, public type, or wire schema is referenced from another file that was not updated. **If the named files change a public symbol, grep for the symbol and flag any unupdated caller.**',
  '3. PRE-EXISTING-BUG-VS-NEW-REGRESSION — a defect exists in the named files but the diff did not introduce it. Do NOT blame the diff for prior bugs; note them in a separate "Pre-existing — out of scope" section. Conversely, if the diff DID introduce or worsen a defect, flag it as a regression.',
  '4. MISSING EDGE CASE — the change adds a code path but does not handle null/undefined/empty/timeout/error/zero/negative inputs the path could see. Walk the change against each natural boundary value.',
  '5. RACE / CONCURRENCY — the change introduces shared state mutation, removes a lock, splits a previously-atomic operation, or adds an await between a check and an action (TOCTOU). Flag these even when no test reproduces.',
  '6. RESOURCE LEAK — the change opens a handle (file, socket, lock, transaction, AbortController) without a guaranteed close path; or introduces an untracked promise that may reject silently.',
  '7. BACKWARD-COMPAT BREAK — the change modifies a public API, exported type, wire schema, environment variable, or CLI flag in a way that breaks existing callers. Flag and require a migration note.',
  '8. SECURITY REGRESSION — the change introduces or worsens auth bypass, injection (SQL/command/prompt), untrusted input flowing to a sink (eval/exec/HTML/SQL), data exposure, or weakened sandboxing. Apply the security lens to every change, not just security-flagged ones.',
  '9. PERFORMANCE REGRESSION — the change adds N+1 queries, unbounded loops, blocking I/O on a hot path, unnecessary deep clones, or shifts work from build/init time to request time. Apply the performance lens to every change, not just performance-flagged ones.',
  '10. IMPLICIT-CONTRACT ASSUMPTION — the changed code relies on the caller (or environment) doing X but the contract (docstring, type, README) does not state X. The change works for in-repo callers but will silently break when the contract is read literally.',
  '',
  'Severity calibration for code reviews:',
  '- critical: the merge would corrupt data, expose credentials, allow auth bypass, break a public API in production, or cause production outage. A reader who applied the fix incorrectly could ship the regression.',
  '- high: the merge would introduce a real bug, security gap, or substantial regression that blocks release. Cross-file ripple where a caller is broken. Missing edge case in a code path that production traffic will hit.',
  '- medium: a real issue worth fixing soon: test gap on a non-trivial change, race condition with low contention, performance regression on a non-hot path, missing edge case on an unlikely input.',
  '- low: stylistic / naming / dead-code / minor-refactor opportunity. Does not change merge safety.',
].join('\n');

/**
 * Counter-balance to the SEVERITY_LADDER's anti-inflation hint.
 *
 * The shared severity ladder ends with "Workers commonly inflate —
 * resist the urge." That bias is correct in the limit (no, the missing
 * comma is not critical) but produces UNDER-finding when combined with
 * a thin per-tool rubric. For code review specifically, the typical
 * failure is missing the cross-file ripple or test gap because the
 * worker only looked at the diff in the named file. This block tells
 * the worker that under-finding is the more common review failure.
 */
export const THOROUGHNESS_REMINDER_REVIEW = [
  'Thoroughness expectation for code reviews:',
  '- For non-trivial diffs (>30 changed lines OR a public symbol changed), zero or 1-2 findings is unusual and usually indicates the rubric was applied too narrowly. Sweep the full failure-mode taxonomy above before declaring "no findings."',
  '- The SEVERITY_LADDER warns against inflation. That warning is calibrated — but the typical UNDER-finding in code review is missing the cross-file ripple or test gap because the worker only looked at the diff in the named file. Apply the failure-mode taxonomy thoroughly first; THEN calibrate severity downward where the impact is small.',
  '- Do not invent findings to hit a quota. But if you have applied all 10 failure modes and still have only stylistic nits, double-check categories 1, 2, 4, and 10 (test gap, cross-file ripple, missing edge case, implicit-contract assumption) — these are the ones reviewers most often miss on first pass and the ones most likely to ship a regression.',
  '',
  'Cross-file pass (REQUIRED when the named files change a public symbol — exported function, exported type, route handler, or wire-schema field):',
  '- Make ONE explicit pass: identify the changed public symbols, grep for their call sites in the rest of the repo, and check whether each call site is consistent with the new signature/return-shape/contract.',
  '- For each (changed symbol, call site) pair, ask: does the call site as currently written still work after this change?',
  '- Worked example. A diff in `src/foo.ts` renames `getUserById(id)` to `getUserById(id, opts)` and makes `opts` required. The grep finds 3 call sites in `src/handlers/auth.ts`, `src/handlers/billing.ts`, `tests/integration/users.test.ts`. None pass `opts`. Flag this as HIGH (or CRITICAL if `auth.ts` would no-op silently rather than error). The fact that `src/foo.ts` looks clean in isolation is exactly the kind of false-clean that ships regressions.',
  '- Most reviewers miss findings of this shape on first pass because they only read the named files. The cross-file pass forces the grep.',
].join('\n');

export const ANNOTATOR_AWARENESS_REVIEW = [
  'After your output, an annotator validates each finding against this code-review rubric:',
  '- Is the finding within the requested focus area (or universally applicable: security, performance, correctness apply to every review)?',
  '- Does the evidence quote real code from the named files OR cite a real call site reachable via grep on the changed symbol?',
  '- Is the severity calibrated to actual merge-safety impact (would a reader who applied the fix incorrectly ship a regression)?',
  '- Is the finding within scope (named files + cross-file ripples on changed symbols + sibling test files), or is it speculation about unrelated code?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped — but cross-file ripple findings backed by call-site references and test-gap findings backed by sibling-test-file references are FULLY VALID, do NOT downgrade them as "speculation about untouched files."',
].join('\n');

import { parseCriteria, type CriterionEntry } from '../criteria-types.js';

/** Structured per-criterion array for parallel-criteria fan-out. */
export const REVIEW_CRITERIA: readonly CriterionEntry[] = parseCriteria(CODE_REVIEW_FAILURE_MODES);
