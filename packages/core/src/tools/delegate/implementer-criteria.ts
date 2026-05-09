/**
 * Delegate-specific implementer criteria.
 *
 * DELEGATE'S PURPOSE — read this before adding categories.
 * mma-delegate is the generic dispatcher for ad-hoc implementation
 * tasks. The caller hands you a `prompt` (and optionally a `done`
 * acceptance criterion, `filePaths`, `verifyCommand`); your output is
 * a diff a REVIEWER will read alongside the brief. The success
 * criterion is:
 *
 *   "Could a reviewer who reads only the brief and your diff approve
 *    the merge without flagging gaps the worker should have caught
 *    or extras the brief did not authorize?"
 *
 * That criterion is what makes a write load-bearing. The reviewer is
 * NOT a rubber stamp — they will ask "did you finish that?" if the
 * fix is partial, and "why did you also touch X?" if the diff has
 * scope creep. Your job is to produce the SMALLEST COMPLETE CHANGE
 * that satisfies the brief — minimal AND complete simultaneously.
 *
 * Delegate is artifact-producing — you write files. Cross-agent
 * spec + quality + diff review applies. The spec the spec-reviewer
 * checks against is the BRIEF (prompt + done), not your interpretation
 * of it. The quality-reviewer checks safety / correctness / style.
 */

/**
 * The orientation block. Goes at the TOP of every delegate prompt.
 *
 * Without an explicit orientation, workers default to "implement
 * something good" — which produces over-implementation (SCOPE CREEP)
 * and under-implementation (SILENT PARTIAL FIX). With this orientation,
 * the worker calibrates against the reviewer's standard: minimal +
 * complete, the brief is the contract.
 */
export const DELEGATE_PURPOSE_ORIENTATION = [
  'Why this delegation exists:',
  'mma-delegate produces a diff a reviewer will read alongside the brief. Success = the diff is the SMALLEST COMPLETE CHANGE that satisfies the brief — minimal AND complete simultaneously. A reviewer should not need to ask "did you finish that?" or "why did you also touch X?".',
  '',
  'For your output to clear that bar:',
  '- Implement EXACTLY what the brief asks for. Not less (SILENT PARTIAL FIX). Not more (SCOPE CREEP).',
  '- If the brief lists `filePaths`, those are the authorized targets. Existing files in the list = pre-verified to read; non-existent paths in the list = explicit output targets you must create. Files NOT in the list are off-limits to write (touch only when the brief\'s task genuinely requires it, and call out the deviation in your summary).',
  '- If the brief includes a `done` acceptance criterion, the reviewer will check your diff against that criterion. Match it precisely.',
  '- If the brief includes a `verifyCommand`, run it after your changes. A green verify is part of "complete"; a red verify is part of "incomplete".',
  '- Match the surrounding code\'s conventions (naming, import style, error handling, formatting). Inventing patterns instead of matching is convention drift — the reviewer will flag it.',
  '- If you change a public symbol (exported function signature, exported type, public method), update the callers in the named files. Leaving callers stale is an INCOMPLETE REFACTOR.',
  '- Do NOT modify tests or fixtures or specs to make a wrong implementation pass. If a test fails, fix the implementation, not the test (unless the brief explicitly says the test is wrong).',
  '',
  'The completion test: would a reviewer who reads ONLY the brief and your diff approve the merge — or would they raise a concern (gap, scope creep, drift, broken caller, undocumented assumption) you should have caught?',
].join('\n');

/**
 * The scope rule for delegate.
 *
 * Replaces the prior one-liner with a concrete contract about what
 * is in scope, what is off-limits, and what to do at the boundary.
 */
export const DELEGATE_SCOPE_RULE = [
  'Scope:',
  '- Strictly what the brief\'s `prompt` (and `done` if present) requests. The brief is the contract.',
  '- Reading: the named `filePaths` plus what the task obviously implies (caller files when the diff changes a public symbol; sibling test files when the brief changes behavior; types files when the diff changes a typed interface).',
  '- Writing: existing files in `filePaths` (modify) and non-existent paths in `filePaths` (create). Files outside `filePaths` are off-limits to write unless the brief\'s task genuinely requires it (e.g. updating a caller because the task changed a signature — call this out in your summary).',
  '- Out of scope: refactors not in the brief, tangential cleanup ("while I\'m here…"), modifying tests/fixtures/specs to mask a wrong implementation, opportunistic style fixes, dependency upgrades the brief did not request.',
].join('\n');

/**
 * The failure-mode taxonomy for delegate.
 *
 * Workers calibrated on "implement something good" tend to over-deliver
 * (scope creep) or under-deliver (silent partial fix). The 9 categories
 * below are the specific patterns reviewers raise as merge-blockers.
 */
export const DELEGATE_FAILURE_MODES = [
  'Patterns to consciously check for. Apply on EVERY delegated task:',
  '',
  '1. SCOPE CREEP — touched files / added features beyond the brief. The reviewer reads the diff and asks "why did you also change Y?" If you cannot answer with "the brief required it", remove the change.',
  '2. SILENT PARTIAL FIX — declared done, work demonstrably incomplete. Naming a step in your summary as "done" when the diff does not contain it is the worst delegate failure mode. Either implement it or report explicitly that you did not.',
  '3. WRONG FILE TARGET — wrote to a path not in `filePaths` (when the caller specified `filePaths`). Existing files outside `filePaths` are off-limits to write. New files outside `filePaths` are scope creep.',
  '4. PHANTOM TEST PASS — claimed "tests pass" without actually running them, OR ran a non-affected suite (e.g. unit tests pass but the change is in a path covered by integration tests). If the brief includes `verifyCommand`, run that exact command and quote the output.',
  '5. CROSS-CUTTING DAMAGE — your fix introduced an unrelated regression in the same edit (e.g. fixing a parser bug but breaking the formatter). Re-read the diff before declaring done; check that nothing OTHER than the brief\'s target changed semantically.',
  '6. CONVENTION DRIFT — invented a naming / import / error-handling / formatting pattern instead of matching the surrounding code. The reviewer will flag this as "matches no neighboring file" — it slows merge.',
  '7. INCOMPLETE REFACTOR — changed a public symbol (exported function signature, exported type, public method) and did not update its callers. Stale callers either crash at runtime or compile but behave wrong. Update callers in the named files; report in your summary if callers exist outside `filePaths`.',
  '8. SPEC OVERREACH — modified tests, fixtures, or interface contracts to make a wrong implementation pass, instead of fixing the implementation. If a test is failing, the FIRST hypothesis is that the implementation is wrong, not the test.',
  '9. UNDOCUMENTED ASSUMPTION — diff relies on the caller doing X (env var set, init function called, dependency installed) without saying so in the brief\'s authoring contract. Either remove the assumption, or document it in your summary so the reviewer can decide if it is acceptable.',
  '',
  'Severity calibration for delegate (in your summary, not via SEVERITY_LADDER which is for read-only tools):',
  '- Issues you notice but do NOT fix: report in summary so the reviewer can decide.',
  '- Issues you encounter that block the brief: report and stop. Do not pick a workaround unilaterally.',
  '- Issues clearly implied by the brief but not literally stated (e.g. "fix bug" implies "regression test added"): implement and name them as "implicit per the brief" in summary.',
].join('\n');

/**
 * Completeness reminder.
 *
 * The shared SEVERITY_LADDER does not apply to write tools. The
 * counter-balance for delegate is opposite to read-only tools: the
 * typical failure is OVER-IMPLEMENTATION (scope creep) and UNDER-
 * IMPLEMENTATION (silent partial fix), often in the same task. This
 * block tells the worker the load-bearing constraint is "minimal AND
 * complete simultaneously".
 */
export const COMPLETENESS_REMINDER_DELEGATE = [
  'Completeness reminder:',
  '- "Smallest complete change" is the bar. Smallest = no extras. Complete = no gaps.',
  '- Most workers on first pass either bloat (extra refactor / extra cleanup / extra abstraction) or skim (declared done with the regression test missing). Both are merge-blockers; aim for the intersection.',
  '- Before declaring done, walk the brief literally:',
  '    1. List every requirement in the prompt (and `done` if present).',
  '    2. For each, ask: "is this in my diff?" If no, you are not done.',
  '    3. Walk the diff in reverse: for each changed file/line, ask: "is this required by a brief item?" If no, remove it.',
  '    4. If `verifyCommand` is set, run it. Quote the relevant output line in your summary.',
  '',
  'Brief-vs-diff walk (REQUIRED on every task):',
  '- For each item in the brief\'s `prompt` and `done`, locate the diff hunk that satisfies it. If you cannot, the item is unsatisfied.',
  '- For each diff hunk, name the brief item it satisfies. If you cannot, the hunk is scope creep.',
  '- Worked example. Brief: "fix the off-by-one in `paginate(page, total)` — `total < pageSize` should still produce one page; add a regression test in `tests/pagination.test.ts`." Naive worker rewrites `paginate` as a clean three-liner with new docstrings, skips the test → SILENT PARTIAL FIX (no test) + SCOPE CREEP (rewrote a function that needed a one-line fix). Correct worker: changes one boundary condition in `paginate` (one line of diff in the implementation file), adds one test in `tests/pagination.test.ts` covering the `total < pageSize` case, runs `verifyCommand` if set, quotes the test name and "1 passed" in the summary, stops. Two diff hunks total, both directly tied to the brief.',
  '- Most workers miss findings of this shape on first pass because the rewrite "feels cleaner". The brief-vs-diff walk forces the question "what did the brief ACTUALLY ask for?".',
].join('\n');
