import type { RunnerShell } from '../runner-shell/shell.js';

export type ReviewVerdict = 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
  evidence: string;
}

export interface ReviewerOutput {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  concernCategories: string[];
  findingsBySeverity: { critical: number; high: number; medium: number; low: number };
}

export class ReviewerEngine {
  constructor(
    private shell: RunnerShell,
    private promptBuilder: { build: (artifact: string) => string },
  ) {}

  async review(
    artifact: string,
    opts: { systemPrompt: string; cwd: string; maxTurns: number },
  ): Promise<ReviewerOutput> {
    const userMessage = this.promptBuilder.build(artifact);
    try {
      const result = await this.shell.run({
        ...opts,
        userMessage,
        toolDefinitions: [],
      });
      return this.parse(result.finalAssistantText);
    } catch {
      return {
        verdict: 'error',
        findings: [],
        concernCategories: [],
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      };
    }
  }

  private parse(text: string): ReviewerOutput {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('reviewer output missing JSON block');
    const obj = JSON.parse(m[1]);
    if (
      !['approved', 'concerns', 'changes_required', 'error', 'skipped'].includes(
        obj.verdict,
      )
    ) {
      throw new Error(`reviewer verdict invalid: ${obj.verdict}`);
    }
    return {
      verdict: obj.verdict,
      findings: obj.findings ?? [],
      concernCategories:
        obj.concernCategories ??
        Array.from(new Set((obj.findings ?? []).map((f: any) => f.category))),
      findingsBySeverity:
        obj.findingsBySeverity ?? this.tallyBySeverity(obj.findings ?? []),
    };
  }

  private tallyBySeverity(
    findings: ReviewFinding[],
  ): ReviewerOutput['findingsBySeverity'] {
    const t = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) t[f.severity] += 1;
    return t;
  }
}
