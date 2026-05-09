import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorInvestigateTemplate: AnnotatorTemplate = {
  role: 'codebase investigation',
  onBriefCheck: 'Each finding should be relevant to the question (not an adjacent question — QUESTION SHIFT failure mode). AND: each load-bearing claim must have a file:line citation OR an explicit "searched X in Y, not found" negative. Findings consistent with the investigate failure-mode taxonomy (wrong file, stale quote, hallucinated citation, confidence overstatement, citation gap, question shift, synthesis without grounding, assumed-current-state) should be filed as the appropriate verdict — do NOT downgrade negative findings for lacking a code quote, and do NOT downgrade inference-with-citations as "speculation" if the cited links are real.',
  evidenceRule: [
    '- Present-thing citations: real `file:line` from files actually read THIS SESSION, with a quote or summary. Citations from training-data memory are hallucinations — flag any cited line that does not currently contain the cited content.',
    '- Absent-thing citations: explicit "searched <pattern> in <path>, no matches" — negative findings are legitimate answers and must NOT be downgraded for lacking a code quote.',
    '- Synthesis findings: cite each link in the reasoning chain by file:line. A synthesis with even one un-cited link is a hand-wave; downgrade confidence or drop the un-cited link.',
    '- Inference-with-citations ("I infer X from Y:42, Z:18") is FULLY VALID and should not be downgraded as "speculation" when the cited links are real. The distinction: inference-with-citations names what is inferred and what is cited; speculation makes a claim without naming the gap.',
  ].join('\n'),
  scopeRule: [
    '- Wherever the question leads is in scope; the question may not name files.',
    '- Negative answers ("X is not used", "Y does not exist") ARE in scope when backed by an explicit search; they are not "unable to find" excuses.',
    '- Drift into unrelated code-review remarks is out of scope.',
    '- Fix proposals / suggestions / improvements are out of scope (this is a read-only Q&A).',
  ].join('\n'),
};
