/**
 * Delegate worker criteria — slimmed in 4.2.3 for cheap-tier success.
 *
 * mma-delegate is the generic dispatcher for ad-hoc implementation
 * tasks. Caller hands you a `prompt` (and optionally a `done` acceptance
 * criterion, `filePaths`, `verifyCommand`); your output is a diff a
 * reviewer will judge alongside the brief.
 *
 * Mirrors the execute-plan slim (16 KB → 3 KB framing). Cheap workers
 * spin on long layered prompts; this version keeps only load-bearing
 * rules. The spec reviewer (complex tier) catches gaps + scope creep and
 * emits targeted instructions for rework; the rework round applies them
 * mechanically.
 */

/**
 * Orientation — "smallest complete change" framing.
 */
export const DELEGATE_PURPOSE_ORIENTATION = [
  'Your job: produce the SMALLEST COMPLETE CHANGE that satisfies the brief — minimal AND complete simultaneously.',
  'A reviewer reads your diff alongside the brief and asks two questions: "did you finish it?" (silent partial fix → blocker) and "why did you also touch X?" (scope creep → blocker). Both must answer cleanly.',
  '',
  'Rules:',
  '- Implement EXACTLY what the brief asks for. Not less. Not more.',
  '- If the brief lists `filePaths`, those are the authorized targets. Existing entries = read-and-modify; non-existent entries = create. Files outside the list are off-limits to write unless the brief\'s task genuinely requires it (call out any deviation in your summary).',
  '- If the brief includes a `done` criterion, your diff must satisfy it precisely.',
  '- If the brief includes a `verifyCommand`, run it after your changes. Green = part of complete; red = part of incomplete.',
  '- If you change a public symbol (exported function signature, exported type, public method), update callers in the named files. Stale callers are an INCOMPLETE REFACTOR.',
  '- Do NOT modify tests or fixtures to make a wrong implementation pass. If a test fails, fix the implementation.',
].join('\n');

export const DELEGATE_SCOPE_RULE = [
  'Scope:',
  '- Strictly what the brief\'s `prompt` (and `done` if present) requests. The brief is the contract.',
  '- Reading: the named `filePaths` plus what the task obviously implies (caller files when the diff changes a public symbol; sibling test files when the brief changes behavior; types files when the diff changes an interface).',
  '- Writing: only files within `filePaths` unless the brief\'s task genuinely requires touching others (e.g. updating a caller because the task changed a signature — note in summary).',
  '- Out of scope: refactors not in the brief, tangential cleanup, modifying tests to mask wrong code, opportunistic style fixes.',
].join('\n');

/**
 * Top-4 failure modes — calibrated from observed reviewer rejections.
 * Dropped from the original 9: WRONG FILE TARGET (subsumed by scope
 * rule), CROSS-CUTTING DAMAGE, CONVENTION DRIFT, SPEC OVERREACH,
 * UNDOCUMENTED ASSUMPTION (low signal, high noise for cheap models).
 */
export const DELEGATE_FAILURE_MODES = [
  'The four ways delegation diverges from intent — check yourself against each before declaring done:',
  '',
  '1. SCOPE CREEP — touched files / added features beyond the brief. For every diff hunk, ask: "is this required by a brief item?" If no, remove it.',
  '2. SILENT PARTIAL FIX — declared done with the work demonstrably incomplete. Naming a step as "done" when the diff doesn\'t contain it is the worst delegate failure. Either implement it or report explicitly that you did not.',
  '3. PHANTOM TEST PASS — claimed "tests pass" without actually running them. If `verifyCommand` is set, run that exact command and quote the output. Otherwise run the focused test for the area you changed.',
  '4. INCOMPLETE REFACTOR — changed a public symbol and did not update callers. Stale callers either crash at runtime or compile-but-misbehave. Update callers in the named files; report any callers outside `filePaths` in your summary.',
].join('\n');

/**
 * Completeness reminder — brief-vs-diff walk only. Worked example
 * dropped (cheap models can apply the rule directly without it).
 */
export const COMPLETENESS_REMINDER_DELEGATE = [
  'Brief-vs-diff walk (REQUIRED before declaring done):',
  '',
  'Walk the brief literally:',
  '  1. List every requirement in `prompt` (and `done` if present).',
  '  2. For each, locate the diff hunk that satisfies it. If you cannot, you are not done.',
  '  3. Walk the diff in reverse: for each changed file/line, name the brief item it satisfies. If you cannot, the hunk is SCOPE CREEP — remove it.',
  '  4. If `verifyCommand` is set, run it. Quote the relevant output line in your summary.',
  '',
  '"Smallest" means no extras. "Complete" means no gaps. Both at once.',
].join('\n');
