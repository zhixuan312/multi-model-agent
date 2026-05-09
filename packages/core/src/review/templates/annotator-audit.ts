import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorAuditTemplate: AnnotatorTemplate = {
  role: 'audit',
  onBriefCheck: 'For each finding, ask: is this the kind of issue the audit asked for? A security audit should produce security findings, not style nits.',
  evidenceRule: [
    '- Audit findings come in three valid shapes:',
    '  1. Doc quote: a verbatim passage from the document showing the issue.',
    '  2. Absence-reference: a precise pointer to where the doc *should* address something but doesn\'t (e.g. "Section 3.2 lists failure modes but is silent on queue overflow").',
    '  3. Claim + contradiction: the doc\'s claim plus a quote from the source it contradicts.',
    '- A finding without one of these three forms is speculation; downgrade to low or drop.',
  ].join('\n'),
  scopeRule: [
    '- The document and what it directly references are in scope.',
    '- Cross-section / cross-doc reasoning IS the value of an audit — do not penalize as speculation.',
    '- Repository-wide enumeration / globbing is out of scope; flag findings whose evidence depends on broad enumeration.',
    '- Coding-style nits on inline examples belong in a code review, not an audit; flag as off-brief.',
  ].join('\n'),
};
