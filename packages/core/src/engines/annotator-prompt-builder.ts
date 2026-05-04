export interface AnnotatorTemplate {
  build(input: { implFindings: unknown[] }): string;
}

export const ANNOTATOR_RUBRIC = [
  '## Output format (REQUIRED)',
  '',
  'Respond with exactly one fenced JSON code block AS THE LAST BLOCK in your',
  'response. The block contains a JSON object with a "findings" array — one',
  'entry per input finding, in the SAME order. NEVER drop a finding. Example:',
  '',
  '```json',
  '{',
  '  "findings": [',
  '    {',
  '      "id": "F1",',
  '      "severity": "critical",',
  '      "claim": "Remote code execution via unsanitized input in src/handler.ts:42",',
  '      "evidence": "user input is passed directly into shellExec() without escaping",',
  '      "suggestion": "Use a parameterized API or escape input",',
  '      "annotatorConfidence": 90',
  '    },',
  '    {',
  '      "id": "F2",',
  '      "severity": "medium",',
  '      "claim": "Auth check missing on /admin endpoint",',
  '      "evidence": "router.get(\'/admin\', adminHandler) — no auth middleware applied",',
  '      "annotatorConfidence": 60',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'Field rules:',
  '- `id`: preserve the input finding\'s id exactly — do not renumber.',
  '- `severity`: RE-JUDGE. One of "critical" | "high" | "medium" | "low" — YOUR',
  '   final judgment, not the worker\'s. The worker\'s value is a hint; you may',
  '   dial it up or down based on actual impact (workers tend to inflate).',
  '   - critical: must fix before any other work (RCE, auth bypass, data loss)',
  '   - high:     serious bug / security issue, blocks release',
  '   - medium:   real issue, should fix soon',
  '   - low:      minor issue, nice to fix',
  '   Map worker-said "mid" -> "medium". When the worker omitted severity, judge.',
  '- `claim`: re-state the finding in one sentence. Tighten vague claims.',
  '- `evidence`: REQUIRED, ≥20 chars, MUST be a verbatim quote from the',
  '   worker\'s original output. The downstream parser flags non-substring',
  '   quotes via evidenceGrounded:false — quote precisely.',
  '- `suggestion`: optional; quote or paraphrase the worker\'s recommended fix.',
  '- `annotatorConfidence`: integer 0-100. How confident YOU (annotator) are',
  '   that this finding is correct, on-brief, and well-grounded:',
  '     80-100: defend without hesitation',
  '     60-79:  plausible, minor gaps',
  '     40-59:  thin evidence',
  '     20-39:  weak / off-brief',
  '      0-19:  unsupported / fabricated',
  '',
  'CRITICAL: Preserve every input finding. The output "findings" array MUST',
  'have exactly the same length as the input findings array. Never drop a',
  'finding — even if it seems weak or off-brief, annotate it and set',
  'annotatorConfidence low rather than omitting it.',
].join('\n');

export class AnnotatorPromptBuilder {
  constructor(
    private templates: Record<
      'audit' | 'review' | 'verify' | 'debug' | 'investigate',
      AnnotatorTemplate
    >,
  ) {}

  build(
    kind: 'audit' | 'review' | 'verify' | 'debug' | 'investigate',
    input: { implFindings: unknown[] },
  ): string {
    return this.templates[kind].build(input);
  }
}
