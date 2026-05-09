import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorDebugTemplate: AnnotatorTemplate = {
  role: 'debugging hypothesis',
  onBriefCheck: 'Each finding should be a hypothesis, root-cause claim, or evidence (reproducer, error pattern, code path).',
  evidenceRule: [
    '- Debug findings are hypotheses with reasoning chains.',
    '- Evidence: reproducer + traced code path (file:line) + observed output.',
    '- Hypothesis-level findings with PARTIAL evidence are valid — that is debugging.',
    '- Severity reflects evidence strength: confirmed root cause = high; plausible = medium; ruled out = low or drop.',
  ].join('\n'),
  scopeRule: [
    '- Cross-file tracing is in scope and required to follow the failure path.',
    '- Out of scope: applied fixes (the worker should propose, not apply); unrelated code-review remarks.',
  ].join('\n'),
};
