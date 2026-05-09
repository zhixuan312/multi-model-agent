import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorAuditTemplate: AnnotatorTemplate = {
  role: 'audit',
  onBriefCheck: 'For each finding, ask: is this the kind of issue the audit asked for? A security audit should produce security findings, not style nits. AND: is this finding consistent with the doc-audit failure-mode taxonomy (recommendation-coherence, internal contradiction, cross-item duplication, independence-claimed-without-evidence, argument soundness, completeness against constraints, fix actionability, drift, scope-creep)? Findings that match the taxonomy and are backed by section references are valid even when they are reasoning-based rather than direct quotes — do NOT downgrade them as "speculation".',
  evidenceRule: [
    '- Audit findings come in FOUR valid shapes:',
    '  1. Doc quote: a verbatim passage from the document showing the issue.',
    '  2. Absence-reference: a precise pointer to where the doc *should* address something but doesn\'t (e.g. "Section 3.2 lists failure modes but is silent on queue overflow").',
    '  3. Claim + contradiction: the doc\'s claim plus a quote from the source it contradicts.',
    '  4. Internal-coherence: a precise reference to two sections of the document that conflict — quote both, OR quote one and name the section ID of the other (e.g. "A8 fix says \'optionally auto-cancel\' but the next sentence says \'do NOT auto-escalate — that crosses into replacing caller judgment\'"). This shape is fully valid for recommendation-coherence, internal-contradiction, argument-soundness, and completeness-against-constraints findings.',
    '- A finding without one of these four forms is speculation; downgrade to low or drop.',
    '- Reasoning-based findings (e.g. "this fix relies on persistence which the doc forbids in Principle #6") are VALID when they cite both the recommendation and the constraint. Do NOT downgrade these as speculation — they are the highest-value kind of audit finding.',
  ].join('\n'),
  scopeRule: [
    '- The document and what it directly references are in scope.',
    '- Cross-section / cross-doc reasoning IS the value of an audit — do not penalize as speculation.',
    '- Repository-wide enumeration / globbing is out of scope; flag findings whose evidence depends on broad enumeration.',
    '- Coding-style nits on inline examples belong in a code review, not an audit; flag as off-brief.',
  ].join('\n'),
};
