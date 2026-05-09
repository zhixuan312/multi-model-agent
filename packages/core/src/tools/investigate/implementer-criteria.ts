/**
 * Investigate-specific implementer criteria.
 *
 * INVESTIGATE'S PURPOSE — read this before adding categories.
 * mma-investigate answers a question about the codebase. The caller is
 * about to ACT on your answer — write code, edit a file, choose between
 * approaches. The success criterion is:
 *
 *   "If the caller acts on this answer literally — opens the cited
 *    files, follows the cited chain, takes the synthesis at face value
 *    — will they end up with correct code?"
 *
 * That criterion is what makes a finding load-bearing. A wrong file
 * path, a stale quote, a hand-waved synthesis, an overstated confidence
 * — all become bugs the caller writes. The investigate-equivalent of
 * "fix is unimplementable" is "the answer points at a file that does
 * not contain what you said it contained."
 *
 * Investigate answers a question about the codebase. Findings can be
 * code-level citations, project-level synthesis, or NEGATIVE results
 * ("searched X, not found"). Negative findings are legitimate answers
 * to "is X still used?" or "where does Y live?" and must not be
 * suppressed.
 *
 * Note: investigate does NOT use SEVERITY_LADDER — its findings are
 * citations and synthesis, not severity-rated issues. Confidence is the
 * calibration dial, not severity.
 */

/**
 * The orientation block. Goes at the TOP of every investigate prompt.
 *
 * Without an explicit purpose statement, workers default to "give a
 * plausible-sounding answer" — which produces hallucinated citations
 * and overstated confidence. With this orientation, every claim is
 * ground-truthed against the file system.
 */
export const INVESTIGATE_PURPOSE_ORIENTATION = [
  'Why this investigation exists:',
  'mma-investigate is the answer-and-act loop. The caller will use your answer to make code edits — open the cited files, take the synthesis at face value, choose an approach based on your confidence rating. A wrong file path becomes a bug; a stale quote becomes a wrong edit; an overstated confidence becomes a misallocated effort.',
  '',
  'For your output to clear that bar, every load-bearing claim must answer:',
  '- Where exactly is this — file:line for present things, or "searched <pattern> in <path>, not found" for absent things?',
  '- Did I read the file just now, or am I reasoning from training data? (only the former counts as evidence)',
  '- For synthesis claims (e.g. "X is used by Y via Z"), is each link in the chain backed by a file:line?',
  '- Is my confidence calibrated to evidence strength, or to how certain I sound?',
  '',
  'A claim without a citation is a guess. A citation that does not match the file currently on disk is a hallucination. A "high confidence" verdict on a synthesis with one weak link is overstatement.',
  '',
  'The completion test: would a caller who reads only your investigation report and the named files end up with the same answer if they re-investigated themselves — or would they find the cited file does not say what you said it said?',
].join('\n');

export const EVIDENCE_RULE_INVESTIGATE = [
  'Evidence grounding (REQUIRED for every citation):',
  '- For present things: `file:line` (or `file:line-line` for spans) plus a quote or summary of what you found. The cited line MUST contain the cited content as of your read — do NOT cite from training-data memory.',
  '- For absent things: explicit `searched <pattern> in <path>, no matches` — negative findings are legitimate answers and should be emitted, not suppressed.',
  '- For synthesis findings (e.g. "X uses Y indirectly via Z"): cite each link in the chain by `file:line`. A synthesis claim with even one un-cited link is a hand-wave.',
  '- For project-level claims that no single file demonstrates (e.g. "the codebase has no shared error type"): write the negative ("searched the repo for `class.*Error` declarations: only X, Y, Z found, none shared") rather than asserting the absence without evidence.',
  '- If you have not read a file, do NOT cite from it. Reasoning-from-training-data is the most common hallucination source — refuse it explicitly.',
].join('\n');

export const SCOPE_RULE_INVESTIGATE = [
  'Scope:',
  '- Wherever the question leads. The question may not name files; you choose where to look.',
  '- If the question is broad (e.g. "how does X work overall?"), break it into sub-questions and answer each with citations rather than producing one un-grounded narrative.',
  '- Out of scope: drift into issues unrelated to the question; opportunistic code review of the code you are investigating (raise that separately, not as an investigation finding); fixes / suggestions / improvements (this is a read-only Q&A — propose nothing).',
].join('\n');

/**
 * The failure-mode taxonomy for investigations.
 *
 * Without this block, workers tend to give plausible-sounding answers
 * with shaky citations. The 8 categories below are the specific ways
 * an investigation answer becomes a bug when the caller acts on it.
 */
export const INVESTIGATE_FAILURE_MODES = [
  'Patterns to consciously check for. Apply on EVERY investigation:',
  '',
  '1. WRONG FILE — a close-named file in a different package/module is cited instead of the actual one (e.g. `src/foo/utils.ts` when the real answer is in `src/bar/utils.ts`). When a name is ambiguous, list all matches and identify which one the question is about.',
  '2. STALE QUOTE — the cited content was at the cited line in your training data but the file has been refactored. Always re-read before quoting; do NOT quote from memory. If the file does not currently contain the quoted content, the citation is invalid.',
  '3. HALLUCINATED CITATION — a `file:line` that does not exist on disk. Verify each citation by actually reading the file at the cited line range. Hallucinated citations are the most caller-actionable failure mode — the caller opens the file and finds nothing there.',
  '4. CONFIDENCE OVERSTATEMENT — claiming "high confidence" when the chain has gaps, when there are multiple plausible answers, or when the citation is partial. Confidence reflects EVIDENCE strength, not how certain you sound.',
  '5. CITATION GAP — a load-bearing claim made without a `file:line`. Synthesis findings without per-link citations are hand-waves. The fix: add the citation, OR downgrade the claim to "I infer X from Y, Z; verify by re-reading <file>".',
  '6. QUESTION SHIFT — answered an adjacent question rather than the one asked. Re-read the question literally before writing the Summary. If the asked question is "where is X declared?" do not answer "where is X used?" without saying so.',
  '7. SYNTHESIS WITHOUT GROUNDING — combined facts into a conclusion that no single citation supports. Either: (a) cite each link explicitly, or (b) mark the conclusion as inference and lower confidence.',
  '8. ASSUMED-CURRENT-STATE — wrote answer from training-data assumption ("normally Foo is implemented this way") instead of the file currently on disk. The codebase may have diverged. Always read; never assume.',
  '',
  'Confidence calibration for investigations:',
  '- high: every load-bearing claim has a file:line citation you read this session; the citation matches the question precisely; no plausible alternative answers were found in your search.',
  '- medium: most claims are cited; one or two links rely on inference from cited facts; alternative answers exist but were ruled out with evidence.',
  '- low: partial answer; significant gaps in the citation chain; the file system has answers you have not searched; or the question is broader than the time spent investigating.',
  '- Use `(none)` for Citations and `low` for Confidence ONLY when the question is genuinely project-level and no code evidence applies. Most "I think it works this way" answers should be `low` confidence with a partial citation, not zero citations.',
].join('\n');

/**
 * Confidence-discipline reminder.
 *
 * The shared SEVERITY_LADDER does not apply to investigate (findings
 * are citations, not severity-rated). Instead, confidence is the
 * calibration dial. The common failure mode is over-confidence —
 * stating "high confidence" because the worker sounds certain,
 * not because the evidence is strong. This block tells the worker
 * confidence reflects evidence strength only.
 */
export const CONFIDENCE_REMINDER_INVESTIGATE = [
  'Confidence-discipline reminder:',
  '- Confidence reflects EVIDENCE STRENGTH (how completely the citation chain supports the answer), not ASSERTION STRENGTH (how certain you sound).',
  '- For each load-bearing claim, ask: "if the caller followed this citation and re-read the file themselves, would they reach the same conclusion?" If yes for every claim → `high`. If yes for most but inference fills the gaps → `medium`. If significant gaps remain → `low`.',
  '- Do NOT use confidence to communicate certainty about the question being answered. Use it to communicate certainty that your answer is CORRECT given your evidence.',
  '- A short investigation that found a clean answer can legitimately be `high`. A long investigation that found a partial answer is `medium` or `low`, no matter how thorough it felt.',
  '',
  'Citation-chain walk (REQUIRED on every load-bearing claim):',
  '- Before writing the Summary, list every claim that drives the answer. For each, ask: "do I have a file:line for this, and did I read the file in this session?"',
  '- If the answer to either is no, the claim is inference. Either downgrade Confidence, or add the citation by reading the file now.',
  '- Worked example. Question: "how does the audit prompt assemble the failure-mode taxonomy?" Naive answer: "The audit tool config imports DOC_AUDIT_FAILURE_MODES from implementer-criteria.ts and joins it into the prompt — confidence: high." Better answer: cite the import line (e.g. `tool-config.ts:14 — import { DOC_AUDIT_FAILURE_MODES, ... }`) AND the consumer line where it is joined into the prompt (e.g. `tool-config.ts:152 — DOC_AUDIT_FAILURE_MODES,` inside the FINDING_FORMAT_INSTRUCTIONS array). Two citations, both verified by reading the file → high confidence is now backed. The naive version asserts the same conclusion but with no actual file:line; if the file has been refactored, the answer is silently wrong.',
  '- Most workers miss findings of this shape on first pass because the answer "feels right". The citation-chain walk forces the file-system check.',
].join('\n');

export const ANNOTATOR_AWARENESS_INVESTIGATE = [
  'After your output, an annotator validates each finding against this investigate rubric:',
  '- Does each citation answer some part of the question (not an adjacent question)?',
  '- Are present-thing citations to real `file:line` from files actually read this session?',
  '- Are negative findings explicit ("searched X in Y, not found") rather than silent omissions?',
  '- For synthesis claims, is each link in the chain cited?',
  '- Does the confidence reflect evidence strength (not assertion strength)?',
  '- Is the answer to the asked question, not a shifted version of it?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped — but negative findings ("searched, not found") and inference-with-citations ("I infer X from Y:42, Z:18") are FULLY VALID. Do NOT downgrade negative findings for lacking a code quote, and do NOT downgrade inference-with-citations as "speculation" if the cited links are real.',
].join('\n');
