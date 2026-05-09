/**
 * Audit-specific implementer criteria.
 *
 * AUDIT'S PURPOSE — read this before adding categories.
 * Most audit targets are spec / plan / design / recommendation files that
 * will subsequently be EXECUTED BY A LOW-JUDGMENT WORKER (a sub-agent that
 * follows the spec literally, with little ability to disambiguate or
 * choose between alternatives). The audit's success criterion is:
 *
 *   "After audit + fixes, can a literal-following worker execute this
 *    artifact without failing, picking wrong, or getting stuck?"
 *
 * That criterion is what makes a finding load-bearing. Stylistic nits
 * don't block execution; ambiguity, contradictions, missing verification,
 * unspecified branches, out-of-order steps, and overloaded terms do.
 *
 * EVIDENCE & SCOPE for prose artifacts.
 * Audit examines a prose artifact (spec, design doc, plan, recommendation
 * doc, API contract, config, brief). The "thing being examined" is text —
 * not source code — so evidence and scope rules differ from review/debug:
 *
 *  - Evidence is a doc quote, OR a precise reference to a section/item
 *    that *should* address the issue but doesn't (absence-finding), OR
 *    a doc-claim + contradicting source (wrong-claim finding), OR
 *    two sections of the doc that contradict each other (internal-
 *    coherence finding).
 *  - Scope is the document and what it directly references; cross-section
 *    reasoning IS the value of an audit.
 *
 * The failure-mode rubric below tells the worker WHAT KINDS of issues to
 * look for in a prose artifact. Without it, workers calibrated on code
 * audits collapse to surface-level proofreading on documents.
 */

/**
 * The orientation block. Goes at the TOP of every audit prompt.
 *
 * This is the load-bearing addition. Without an explicit purpose statement,
 * workers default to "find issues in this doc" — which produces stylistic
 * proofreading. With this orientation, they look for issues that would
 * BLOCK EXECUTION by a literal-following worker, which is what the caller
 * actually needs.
 */
export const AUDIT_PURPOSE_ORIENTATION = [
  'Why this audit exists:',
  'The artifact you are auditing is most likely a spec, plan, design doc, or recommendation doc that will subsequently be EXECUTED BY A LOW-JUDGMENT WORKER — a sub-agent that follows instructions literally, has limited ability to disambiguate, and cannot recover from contradictions.',
  '',
  'Your job is to find anywhere a literal-following worker would:',
  '- get stuck on ambiguity (e.g. "implement the function" with no signature, location, or contract)',
  '- pick wrong on an unspecified branch (e.g. "if X then Y" with no "otherwise")',
  '- implement contradictions (section A says use X, section B says use Y, both apparently authoritative)',
  '- skip a requirement that is implicit or buried (the worker only does what is explicitly stated)',
  '- be unable to verify completion (no acceptance criteria, no done condition, no test command)',
  '- misinterpret an overloaded term (the same word means two different things in two sections)',
  '- execute steps out of order (step 3 needs the output of step 5)',
  '- act on an unbounded scope ("fix the bug" with no scope boundary)',
  '- need context that is referenced but not provided (a helper, a flag, a file the spec assumes the worker knows)',
  '- produce data of an unspecified shape (return value, file format, error envelope)',
  '',
  'A finding that points at any of these failure-mode triggers is high-value EVEN IF the prose reads cleanly. Conversely, a stylistic nit that does not block execution is low-priority no matter how clean the wording.',
  '',
  'When you have completed this audit and its fixes have been applied, the test is: would a worker that reads only this artifact, follows it literally, and asks no clarifying questions, produce the right outcome? If yes, the audit succeeded.',
].join('\n');

export const EVIDENCE_RULE_AUDIT = [
  'Evidence grounding (REQUIRED for every finding):',
  '- For issues IN the doc: quote the exact passage that demonstrates the issue.',
  '- For ABSENCES (the doc is silent on something it should specify): name the section that should address it. Example: "Section 3.2 enumerates failure modes but does not specify queue-overflow behavior." This is an absence-finding and is fully valid evidence.',
  '- For WRONG-CLAIM findings: quote the doc\'s claim AND the source that contradicts it (the actual code, the referenced spec, etc.).',
  '- For INTERNAL-COHERENCE findings (two parts of the doc conflict, a recommendation contradicts a stated constraint, a fix relies on something the doc forbids): quote both passages OR quote one and name the section ID of the other.',
  '- A finding without one of these four forms of evidence is speculation. Note "investigation needed" in your summary instead.',
].join('\n');

export const SCOPE_RULE_AUDIT = [
  'Scope:',
  '- The document itself plus any artifact the document directly references (cited code, linked spec, embedded config).',
  '- Cross-section reasoning within the document IS in scope and is often the highest-value kind of finding.',
  '- Do NOT enumerate the repository or glob across all source files. If verifying a referenced file or symbol, read or grep for that specific name only — the goal is to evaluate the document, not catalog the codebase.',
  '- Out of scope: speculation about content the document does not reference; coding-style nits on inline code examples (those belong in a code review, not an audit).',
].join('\n');

/**
 * The failure-mode rubric for prose-document audits.
 *
 * This is the load-bearing addition. Without an explicit taxonomy, workers
 * calibrated on source-code rubrics (off-by-one, type mismatches, dead code)
 * have nothing to look for in a spec/plan/recommendation doc and emit only
 * surface nits. The 9 categories below cover what actually goes wrong in
 * non-trivial prose artifacts and are independent of the audit-type label.
 */
export const DOC_AUDIT_FAILURE_MODES = [
  'Look for these kinds of issues — applicable to ALL prose-document audits regardless of auditType. The auditType (default / security / performance) tells you which lens to weight, but every doc audit should sweep the full taxonomy:',
  '',
  '1. RECOMMENDATION-COHERENCE — does the proposed fix actually solve the stated problem given the doc\'s own stated constraints? A fix that requires X when the doc forbids X is logically incomplete. **Always check fixes against any explicit principles, constraints, invariants, or "what we won\'t do" sections in the doc itself.** Example: a doc that lists "no persistence" as a principle cannot have a fix that disambiguates "id existed before" from "id never existed" without persistence — that fix is unimplementable.',
  '2. INTERNAL CONTRADICTION — does section A say something incompatible with section B? Does a methodology disclaimer ("these numbers are approximations") undercut a load-bearing claim built on those same numbers? Does a "do not auto-X" rule sit next to an "auto-X above threshold" recommendation?',
  '3. CROSS-ITEM DUPLICATION — are two items addressing the same root cause without acknowledging each other? Should they be merged or cross-referenced? Look across the WHOLE doc for items that target the same underlying problem from different angles.',
  '4. INDEPENDENCE-CLAIMED-WITHOUT-EVIDENCE — is X asserted as independent of Y when the evidence shows correlation, co-occurrence, or shared mechanism?',
  '5. ARGUMENT SOUNDNESS — does the evidence chain support the conclusion? Does a headline ("95% wasted") rest on data the doc itself flags as unreliable? Does a severity rating match the evidence depth?',
  '6. COMPLETENESS AGAINST CONSTRAINTS — does any constraint stated elsewhere render a recommendation infeasible? Is a fix step that depends on persistence proposed in a doc that forbids persistence? **If the doc has a principles, invariants, or constraints section, walk every recommendation through every constraint and flag mismatches.**',
  '7. FIX ACTIONABILITY — is the proposed fix complete enough to implement, or does it stop at "fix it" / vague verbs? Does it leave open which subsystem owns the change? Are step-by-step actions or only goals?',
  '8. DRIFT / STALENESS — does any claim in one section contradict more recently revised material in the same doc? **Specifically: count items the doc claims to discuss (e.g. "across all three sessions", "the four highest-impact items", "we have N tools") and verify the count against the actual list elsewhere.** If the count is wrong, that\'s drift. Other drift signals: version labels, renamed sections, references to removed items.',
  '9. SCOPE-CREEP / FRAMING — do recommendations exceed what the evidence supports? Does the framing (table title, bucket label, headline) misrepresent what the row contents actually say?',
  '10. STRUCTURAL CONSISTENCY — do similar items in a list/table follow the same shape? If one row has a Verification subsection and the others don\'t, that\'s structural inconsistency. If items are numbered "1, 1b, 2, 3" the duplicate "1" is a structural break. If a column is labeled "Fix direction" but one row\'s cell holds verification criteria, that\'s a column-content mismatch.',
  '11. METADATA COMPLETENESS — for living/revised documents: is there a "last updated" / "as of" / version stamp? When findings claim "still unfixed in version X", is there a date timeline that supports the claim?',
  '',
  'Severity calibration for doc audits:',
  '- critical: a recommendation that, if implemented, would fail or cause harm because the doc is internally incoherent (e.g. a fix that depends on something the doc forbids). Or: a contradiction that would silently lead to wrong implementation if a reader followed both passages.',
  '- high: a substantive missing recommendation, an incorrect claim of independence between two issues, an evidence chain that does not support a load-bearing conclusion, OR a fix that violates a stated principle/constraint of the doc itself.',
  '- medium: argument soundness gap, fix actionability gap, drift between sections (item-count mismatch), structural inconsistency between similar items, scope-creep risk that needs a guardrail.',
  '- low: stylistic, labeling, or formatting issues; missing metadata; minor cross-reference fixes.',
].join('\n');

/**
 * Counter-balance to the SEVERITY_LADDER's anti-inflation hint.
 *
 * The shared severity ladder ends with "Workers commonly inflate — resist
 * the urge." That bias is correct for code reviews, where over-flagging
 * stylistic preferences is the common failure. For prose-document audits
 * the opposite is true: workers UNDER-find because they have nothing to
 * pattern-match against in their training. This block tells the worker
 * the doc-audit failure mode is silence, not noise.
 */
export const THOROUGHNESS_REMINDER_AUDIT = [
  'Thoroughness expectation for prose-document audits:',
  '- For non-trivial documents (>500 words), zero or 1-2 findings is unusual and usually indicates the rubric was applied too narrowly. Sweep the full failure-mode taxonomy above before declaring "no findings."',
  '- The SEVERITY_LADDER warns against inflation. That warning is calibrated for code reviews — for prose audits the typical failure mode is the opposite (under-finding because the worker only looked for surface nits). Apply the failure-mode taxonomy thoroughly first; THEN calibrate severity downward where the impact is small.',
  '- Do not invent findings to hit a quota. But if you have applied all 11 failure modes and still have only stylistic nits, double-check categories 1, 2, 5, 6, and 8 (recommendation-coherence, internal contradiction, argument soundness, completeness against constraints, drift) — these are the ones workers most often miss on first pass.',
  '',
  'Principle-mapping pass (REQUIRED when the doc has a principles / constraints / "what we won\'t do" section):',
  '- Make ONE explicit pass walking each recommendation against each principle/constraint listed in the doc.',
  '- For each (recommendation, constraint) pair, ask: does this recommendation, as written, require something the constraint forbids? Or rely on something the constraint says is unavailable?',
  '- Worked example (illustrative — DO NOT match this verbatim against the doc you are auditing). Suppose a doc states Principle X: "Operations must be deterministic — no random sources." Suppose recommendation R proposes: "On request collision, generate a fresh tiebreaker using the system entropy pool." Chain: the tiebreaker uses entropy; entropy is non-deterministic; Principle X forbids non-determinism; therefore R is unimplementable as written without breaking Principle X. → File this as a HIGH-severity recommendation-coherence finding. The general pattern: a fix that REQUIRES something a constraint FORBIDS, or RELIES ON something a constraint says is UNAVAILABLE, is a load-bearing finding regardless of how clean the fix\'s prose reads.',
  '- Most workers miss findings of this shape on first pass because the chain spans two non-adjacent sections. The principle-mapping pass forces you to make the chain.',
].join('\n');

export const ANNOTATOR_AWARENESS_AUDIT = [
  'After your output, an annotator validates each finding against this audit-specific rubric:',
  '- Is the finding about the document (contradiction / absence / ambiguity / wrong claim / scope gap / recommendation-coherence / argument-soundness)?',
  '- Is the evidence one of the four valid shapes: doc quote, absence-reference, claim+contradiction, OR internal-coherence cross-section reference?',
  '- Is the severity calibrated to actual downstream-execution impact (does following the recommendation as written produce a wrong outcome)?',
  '- Is the finding within the document\'s scope, or is it speculation about untouched material?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped — but logical-coherence and argument-soundness findings backed by section references are FULLY VALID, do NOT downgrade them as "speculation."',
].join('\n');
