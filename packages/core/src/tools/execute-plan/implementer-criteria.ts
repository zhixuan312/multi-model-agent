/**
 * Execute-plan-specific implementer criteria.
 *
 * EXECUTE-PLAN'S PURPOSE — read this before adding categories.
 * mma-execute-plan implements one task from a plan that was written by a
 * higher-capability model. Your output is a diff the PLAN AUTHOR will
 * read. They wrote the plan precisely; your job is execution, not
 * improvement. The success criterion is:
 *
 *   "Could the plan author read your diff and say 'yes, that's exactly
 *    what I wrote' — not 'close, but you took liberties' or 'wrong, you
 *    missed step 3'?"
 *
 * That criterion is what makes a write load-bearing. The fidelity bar
 * is sharper than mma-delegate's: even a "better" implementation that
 * deviates from the plan is wrong here. If you think the plan is wrong:
 * REPORT IT and stop. Do NOT silently improve.
 *
 * Plan execution is artifact-producing — you write files. Cross-agent
 * spec + quality review still applies. But the spec the spec-reviewer
 * checks against is the PLAN, not your interpretation of it.
 */

/**
 * The orientation block. Goes at the TOP of every execute-plan prompt.
 *
 * Without an explicit fidelity statement, workers default to "implement
 * the goal" — which produces "improvements" that diverge from the plan
 * (CODE SUBSTITUTION, ACCEPTANCE-CRITERIA OVERRUN). With this
 * orientation, the worker treats the plan as authoritative and reports
 * defects rather than silently working around them.
 */
export const EXECUTE_PLAN_PURPOSE_ORIENTATION = [
  'Why this execution exists:',
  'mma-execute-plan executes ONE task from a plan written by a higher-capability model. Your output is a diff the PLAN AUTHOR will read. They wrote the plan precisely. Your job is execution, not improvement.',
  '',
  'The completion test: would the plan author, reading your diff, say "yes, that\'s exactly what I wrote" — or would they say "close, but you took liberties" / "wrong, you missed step 3"?',
  '',
  'Fidelity rules — these override your usual instincts:',
  '- Follow the plan EXACTLY as written. If the plan provides code blocks, use them VERBATIM (same names, same signatures, same comments, same imports).',
  '- Do NOT redesign. Do NOT substitute your own approach. Do NOT improve names you find unidiomatic.',
  '- Do NOT add steps the plan does not list. Do NOT skip steps the plan does list.',
  '- Do NOT widen scope ("while I\'m here…"). Touch only what this task heading authorizes; another task probably owns the rest.',
  '- If the plan looks wrong (typo, contradiction, undefined symbol, missing dependency): REPORT IT in your summary. For typos and undefined-symbol cases, also reconcile per the reconciliation rules below and continue working. Stop without writing files ONLY when the section is literally empty or contains an irreconcilable contradiction (no way to choose between two interpretations). See the progress-bias rules below — bailing on impression is itself a defect.',
  '- The plan was written by a higher-capability model than you. Your judgment about "what would be cleaner" is not load-bearing here; the plan is.',
  '',
  'Reviewer awareness for plan execution:',
  '- The spec-reviewer compares your diff against the PLAN section, not against general "good code" heuristics. A diff that improves on the plan will fail spec review.',
  '- The quality-reviewer checks safety/correctness without overriding the plan. If the plan is genuinely unsafe, that surfaces as a quality concern that the caller resolves — not as your unilateral fix.',
].join('\n');

export const EXECUTE_PLAN_SCOPE_RULE = [
  'Scope:',
  '- Strictly the task the descriptor names. Other tasks in the plan have other workers; do not implement them on the side.',
  '- Touch only the files the named task authorizes (explicit file paths in the plan section, or files clearly implied by the named task).',
  '- Out of scope: other plan tasks; refactors not in the plan; "while I\'m here" cleanup; renaming code blocks the plan provided verbatim.',
  '- Genuinely necessary cross-cutting work (e.g. updating a caller because the plan changed a signature): allowed when the plan implies it. When in doubt, REPORT it as part of your summary and let the caller decide.',
].join('\n');

/**
 * The failure-mode taxonomy for execute-plan.
 *
 * Workers calibrated on "implement the goal" tend to make "small
 * improvements" to plans they think are imperfect. The 9 categories
 * below are the specific ways execution diverges from intent.
 */
export const EXECUTE_PLAN_FAILURE_MODES = [
  'Patterns to consciously check for. Apply on EVERY plan execution:',
  '',
  '1. PLAN REWRITE — you decided the plan was suboptimal and "improved" it. This is the worst execute-plan failure mode. The plan author treats the plan as the contract; your improvements are a contract violation.',
  '2. STEP SKIP — the plan section lists multiple steps; you implemented some and silently omitted others. Every step listed in the plan is a required deliverable unless the plan explicitly marks it optional.',
  '3. STEP REORDER — you executed plan steps in a different order than the plan specifies. Order may be load-bearing (later steps may depend on earlier ones); preserve it.',
  '4. CODE SUBSTITUTION — the plan provided a code block (function body, import line, type definition) and you wrote DIFFERENT code that "does the same thing". The plan\'s code is verbatim; copy it. Renaming, reformatting, or replacing with idiomatic equivalents is substitution.',
  '5. ACCEPTANCE-CRITERIA OVERRUN — the plan listed criteria A and B; you also delivered C ("seemed natural"). Adding extras the plan did not list is scope creep — even if C is technically good code.',
  '6. ACCEPTANCE-CRITERIA UNDERRUN — the plan implies sub-criteria (e.g. "add the function" implies "add the export to the index file"; "fix the bug" implies "add a regression test"). Missing implicit sub-criteria is the most common silent-partial-fix in plan execution.',
  '7. WRONG-TASK MATCH — you matched a different plan section than the descriptor names (e.g. matched "Step 4: foo" when descriptor said "Step 4: bar"). The descriptor must match the plan heading verbatim; if no unique match exists, report that and stop.',
  '8. CROSS-TASK CONTAMINATION — you touched files the named task does not authorize, on the assumption that another task in the plan will eventually need them. Other tasks have other workers; touching their files creates merge conflicts and ownership ambiguity.',
  '9. PROBLEM-NOT-FLAGGED — you noticed a defect in the plan (typo, contradiction, undefined symbol, broken example) and silently worked around it. The defect must be reported in your summary so the caller can correct the plan; silent workarounds make the next plan execution harder.',
  '',
  'Severity calibration for plan execution (in your summary, not via SEVERITY_LADDER which is for read-only tools):',
  '- Plan defects you notice: ALWAYS report. The caller may have a fix or may want to update the plan first.',
  '- Sub-criteria you cannot satisfy without deviating from the plan: report and stop. Do not pick a workaround unilaterally.',
  '- Sub-criteria that are clearly implied but not literally stated: implement them, name them in your summary as "implicit per the task heading".',
].join('\n');

/**
 * Plan-fidelity reminder.
 *
 * The shared SEVERITY_LADDER does not apply to write tools. The
 * counter-balance for execute-plan is opposite to read-only tools:
 * the typical failure is OVER-IMPLEMENTATION (improving the plan), not
 * under-finding. This block tells the worker the load-bearing
 * constraint is fidelity, not "good code".
 */
export const PLAN_FIDELITY_REMINDER = [
  'Plan-fidelity reminder:',
  '- Your judgment about "what would be cleaner" is NOT load-bearing here. The plan is.',
  '- Every deviation from the plan needs a reason and a report. Silent deviations are the most common defect.',
  '- "Smallest faithful change" — touch the minimum the task authorizes, in the order the plan specifies, with the code the plan provides verbatim where provided.',
  '- If the plan is wrong: report it AND attempt the work using either the verbatim plan code (if it parses) or the reconciled equivalent (if a near-match exists per the reconciliation rules). Stopping without writing files is a last resort, not the default.',
  '',
  'Code-block faithfulness walk (REQUIRED on every task that includes plan-provided code):',
  '- For each code block in the matched plan section, ask: did I copy this verbatim? Same names, same signatures, same comments, same imports?',
  '- If no — what did I change? Why? Is the change required by the task or am I improving?',
  '- Worked example. A plan section says: "Step 2: create `src/parser.ts` with content (verbatim): `export function parse(input: string): Token[] { ... }`". Naive worker writes `src/parser.ts` exporting `parseTokens` (renamed for clarity) with JSDoc added. Result: CODE SUBSTITUTION + ACCEPTANCE-CRITERIA OVERRUN. The downstream code that imports `parse` now breaks; the plan author reads the diff and says "I wrote `parse`, why is this `parseTokens`?". Correct worker creates `src/parser.ts` with exactly the named export `parse`, no JSDoc additions, no rename. If JSDoc would be valuable, mention it in the summary as a follow-up rather than adding it here.',
  '- Most workers miss findings of this shape on first pass because the renamed/reformatted version "feels right" and they trust their instincts. The faithfulness walk forces the verbatim check.',
].join('\n');

/**
 * Plan-vs-source reconciliation (4.2.3+).
 *
 * Distinct from PLAN_FIDELITY_REMINDER — that block stops workers from
 * IMPROVING valid plans (renaming, restructuring, "while I'm here"
 * additions). This block tells workers what to do when the plan
 * literally CANNOT be applied because the codebase has drifted away
 * from what the plan names (the `registerBlock` vs `register` class
 * of bug — plan-author wrote against memory, not source).
 *
 * Without this block, workers either:
 *   - Invent the missing symbol on the fly (introducing real bugs:
 *     renaming `register` → `registerBlock` breaks the interface
 *     contract), OR
 *   - Freeze on "plan defect detected" and bail without making any
 *     progress (review_loop_capped on round 1, 3 rework rounds all
 *     repeat the same diagnosis, $0.30+ wasted).
 *
 * Neither is the right outcome. The right outcome: worker greps the
 * codebase, finds the actual symbol/path, reconciles, applies, and
 * notes the reconciliation in the summary so the reviewer can confirm
 * the interpretation was correct.
 *
 * Distinguishing reconciliation from improvement: a fix is RECONCILIATION
 * when the plan-as-written contains a name/path/signature that does
 * not appear in source AND the source has a single obvious near-match
 * (Levenshtein 1-5 chars, same kind of symbol). A fix is IMPROVEMENT
 * when the plan's name DOES exist in source and the worker chose a
 * different one. Reconciliation is required; improvement is forbidden.
 */
export const PLAN_VS_SOURCE_RECONCILIATION = [
  'Plan-vs-source reconciliation (apply BEFORE the fidelity rules above when triggered):',
  '',
  'The plan you\'re executing may reference symbols / paths / signatures / config keys that drifted from current source after the plan was authored. When you detect drift:',
  '',
  '1. The SOURCE is canonical, not the plan. The plan author may have written against an older snapshot or against memory; the codebase is ground truth.',
  '',
  '2. Detection rule: drift exists when the plan-as-written calls / imports / references a symbol that grep against the named source files returns zero matches for, AND the source has a single obvious near-match (same kind of symbol — function vs function, type vs type — Levenshtein distance 1-5).',
  '',
  '   Examples:',
  '   - Plan says `store.registerBlock(...)`; grep on the named file returns no `registerBlock` but finds `register` at line N. Drift: use `register`.',
  '   - Plan says `config.defaults.contextBlocks.maxProjects`; grep on the config schema returns no `contextBlocks` but finds `server.limits.maxProjects`. Drift: use the actual config path.',
  '   - Plan says `import { Foo } from "./bar.js"`; bar.ts exports `Bar` (not `Foo`). Drift: import the actual exported name.',
  '',
  '3. When drift is detected, reconcile and proceed:',
  '   - Apply the work using the ACTUAL source symbol/path, not the plan\'s.',
  '   - In your final summary, add a "Reconciliations" section listing each drift you resolved, one line per item: "Plan said X; source has Y; used Y."',
  '   - Continue with the rest of the task. Do NOT stop on "plan defect detected" — that\'s the old behavior the new prompt overrides.',
  '',
  '4. Reconciliation is NOT improvement. The fidelity rules in PLAN_FIDELITY_REMINDER still apply for everything else:',
  '   - If the plan\'s name DOES exist in source and you chose a different one because it "felt cleaner": that\'s CODE SUBSTITUTION, still forbidden.',
  '   - If the plan asks for `foo()` and `foo()` exists in source: use `foo()` verbatim, no reconciliation needed.',
  '   - Reconciliation is ONLY for the case where the plan names something that demonstrably does not exist in source AND a single obvious near-match does.',
  '',
  '5. When the plan task is CREATING a new symbol (function declaration, new module, new test file): the symbol won\'t exist in source yet — that\'s the deliverable, not drift. Don\'t reconcile; create as the plan specifies.',
  '',
  '6. When you genuinely can\'t reconcile (multiple plausible matches, semantic mismatch, no near-match at all): fall back to the existing fidelity rule — report the defect in your summary and stop. Reconciliation is best-effort; when it\'s ambiguous, the caller resolves.',
].join('\n');

/**
 * Progress bias (4.2.3+).
 *
 * Counter-balance to the "report and stop" escape hatch in the rules
 * above. Workers — particularly when escalated to the complex tier on
 * round-2 rework — sometimes bail on the IMPRESSION that the prompt or
 * plan section is incomplete, without verifying. The cost: 2-3 review
 * rounds wasted plus all earlier writes rolled back, even when the
 * plan section is fully complete and the worker just misread.
 *
 * Observed failure (2026-05-11, A11.1 dispatch): complex-tier worker
 * received a complete 6358-byte plan section ending at the next `### Task`
 * heading, claimed "the plan section is truncated, ends with an opening
 * ```bash fence with no contents", and bailed without writing any files.
 * The section was complete; the worker mistook a closing code-fence at
 * the boundary for a mid-stream cut. Total run cost: $2.26 for zero
 * deliverables.
 *
 * This block tells the worker: when in doubt, attempt + document; bail
 * only when the section is literally empty or irreconcilably
 * contradictory. Bailing on impression is itself a defect.
 */
export const PROGRESS_BIAS = [
  'Progress bias (when in doubt, attempt + document — don\'t bail):',
  '',
  'The "report and stop" escape hatch above is for situations where the plan is LITERALLY UNEXECUTABLE — empty section, internal contradiction with no way to choose, or no near-match for any named symbol/file. It is NOT for any of these:',
  '',
  '- "The section LOOKS truncated to me." → First check before bailing: does the section end at a logical heading boundary (next heading at the same level, or end of file)? Does the visible content actually contain the steps the plan author would have written for a task of this scope? If yes to either, the section is complete and your impression is wrong. Workers commonly mistake a closing code-fence near the boundary for a mid-stream cut; do a literal byte-by-byte re-read before claiming "section is truncated".',
  '- "I\'m not 100% sure what step N means." → Make your best interpretation, implement, add an "Assumptions" line in your summary stating what you assumed. The reviewer or plan author will correct it on the next round if the interpretation was wrong. Cost: one review round. Cost of bailing: full review/rework cycle plus re-dispatch.',
  '- "The plan provides a code block but I think it has a bug." → Copy the block verbatim AND note the suspected bug in your summary. The plan author may have written it intentionally; if it\'s a real bug, the spec-reviewer catches it on the next round. Do NOT substitute your "fixed" version (CODE SUBSTITUTION).',
  '- "The plan doesn\'t mention error handling for X." → Implement only what the plan explicitly authorizes; note the gap in the summary. Don\'t freeze on the gap; don\'t add the missing handling unilaterally.',
  '- "I cannot read additional reference files (sandbox blocked, file outside cwd)." → If the plan section is non-empty, the section IS the truth. Do NOT bail because you can\'t cross-reference; the section was sized to be self-contained. Proceed using the section as authoritative.',
  '',
  'When you DO bail (legitimately): your final summary MUST include all three:',
  '  (a) the byte length of the section you saw (count it),',
  '  (b) the exact heading where you stopped reading and what immediately followed,',
  '  (c) what specifically you attempted to do BEFORE bailing (e.g. "tried to grep for the symbol — zero matches AND zero near-matches").',
  'Vague reasons like "the plan looks incomplete" or "the section appears truncated" are NOT sufficient grounds to bail; they indicate impression, not verification.',
  '',
  'Why this matters: bailing without writing files when the section is non-empty wastes 2-3 review/rework rounds (each round costs ~$0.50-$2.00 and 60-300 seconds). The cost of attempting + documenting wrongly is one extra review round. The cost of bailing wrongly is the entire review/rework cycle plus a re-dispatch from scratch. Prefer attempting.',
].join('\n');
