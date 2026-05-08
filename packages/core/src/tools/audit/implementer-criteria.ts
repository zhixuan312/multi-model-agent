/**
 * Audit-specific implementer criteria.
 *
 * Audit examines a prose artifact (spec, design doc, API contract,
 * config, plan). The "thing being examined" is text — not source code —
 * so evidence and scope rules differ from review/debug:
 *
 *  - Evidence is a doc quote, OR a precise reference to a section/item
 *    that *should* address the issue but doesn't (absence-finding), OR
 *    a doc-claim + contradicting source (wrong-claim finding).
 *  - Scope is the document and what it directly references; cross-section
 *    reasoning IS the value of an audit.
 */

export const EVIDENCE_RULE_AUDIT = [
  'Evidence grounding (REQUIRED for every finding):',
  '- For issues IN the doc: quote the exact passage that demonstrates the issue.',
  '- For ABSENCES (the doc is silent on something it should specify): name the section that should address it. Example: "Section 3.2 enumerates failure modes but does not specify queue-overflow behavior."',
  '- For WRONG-CLAIM findings: quote the doc\'s claim AND the source that contradicts it (the actual code, the referenced spec, etc.).',
  '- A finding without one of these three forms of evidence is speculation. Note "investigation needed" in your summary instead.',
].join('\n');

export const SCOPE_RULE_AUDIT = [
  'Scope:',
  '- The document itself plus any artifact the document directly references (cited code, linked spec, embedded config).',
  '- Cross-section reasoning within the document IS in scope and often the highest-value kind of finding.',
  '- Do NOT enumerate the repository or glob across all source files. If verifying a referenced file or symbol, read or grep for that specific name only — the goal is to evaluate the document, not catalog the codebase.',
  '- Out of scope: speculation about content the document does not reference; coding-style nits on inline code examples (those belong in a code review, not an audit).',
].join('\n');

export const ANNOTATOR_AWARENESS_AUDIT = [
  'After your output, an annotator validates each finding against this audit-specific rubric:',
  '- Is the finding about the document (contradiction / absence / ambiguity / wrong claim / scope gap)?',
  '- Is the evidence either a doc quote OR a precise reference for absence-findings OR a doc-claim + contradicting source?',
  '- Is the severity calibrated to actual downstream-execution impact?',
  '- Is the finding within the document\'s scope, or is it speculation about untouched material?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped.',
].join('\n');
