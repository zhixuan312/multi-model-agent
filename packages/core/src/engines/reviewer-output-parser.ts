import type { ReviewerOutput, ReviewFinding, ReviewVerdict } from './reviewer-engine.js';

const VALID_VERDICTS: ReviewVerdict[] = ['approved', 'concerns', 'changes_required', 'error', 'skipped'];

export class ReviewerOutputParser {
  parse(text: string): ReviewerOutput {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('reviewer output missing JSON block');
    const obj = JSON.parse(m[1]);
    if (!VALID_VERDICTS.includes(obj.verdict)) {
      throw new Error(`reviewer verdict invalid: ${obj.verdict}; must be one of ${VALID_VERDICTS.join('|')}`);
    }
    const findings: ReviewFinding[] = obj.findings ?? [];
    return {
      verdict: obj.verdict,
      findings,
      concernCategories: obj.concernCategories ?? Array.from(new Set(findings.map(f => f.category))),
      findingsBySeverity: obj.findingsBySeverity ?? this.tally(findings),
    };
  }

  private tally(findings: ReviewFinding[]): ReviewerOutput['findingsBySeverity'] {
    const t = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) t[f.severity] += 1;
    return t;
  }
}
