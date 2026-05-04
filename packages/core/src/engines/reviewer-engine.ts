import type { RunnerShell } from '../runner-shell/shell.js';
import { ReviewerOutputParser } from './reviewer-output-parser.js';

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
  private parser = new ReviewerOutputParser();

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
      return this.parser.parse(result.finalAssistantText);
    } catch {
      return {
        verdict: 'error',
        findings: [],
        concernCategories: [],
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      };
    }
  }
}
