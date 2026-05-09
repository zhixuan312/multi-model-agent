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
  '- If the plan looks wrong (typo, contradiction, undefined symbol, missing dependency): REPORT IT in your summary and stop. Do NOT silently work around it. Do NOT silently fix it.',
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
  '- If the plan is wrong: report and stop. Do NOT silently fix the plan.',
  '',
  'Code-block faithfulness walk (REQUIRED on every task that includes plan-provided code):',
  '- For each code block in the matched plan section, ask: did I copy this verbatim? Same names, same signatures, same comments, same imports?',
  '- If no — what did I change? Why? Is the change required by the task or am I improving?',
  '- Worked example. A plan section says: "Step 2: create `src/parser.ts` with content (verbatim): `export function parse(input: string): Token[] { ... }`". Naive worker writes `src/parser.ts` exporting `parseTokens` (renamed for clarity) with JSDoc added. Result: CODE SUBSTITUTION + ACCEPTANCE-CRITERIA OVERRUN. The downstream code that imports `parse` now breaks; the plan author reads the diff and says "I wrote `parse`, why is this `parseTokens`?". Correct worker creates `src/parser.ts` with exactly the named export `parse`, no JSDoc additions, no rename. If JSDoc would be valuable, mention it in the summary as a follow-up rather than adding it here.',
  '- Most workers miss findings of this shape on first pass because the renamed/reformatted version "feels right" and they trust their instincts. The faithfulness walk forces the verbatim check.',
].join('\n');
