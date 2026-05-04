import type { RunnerShell } from '../runner-shell/shell.js';

export interface AnnotatedFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  claim: string;
  evidence: string;
  evidenceGrounded: boolean;
  suggestion?: string;
  annotatorConfidence: number;   // 0..100 integer
}

export interface AnnotatorOutput {
  verdict: 'annotated' | 'error';
  findings: AnnotatedFinding[];
}

export class AnnotatorEngine {
  constructor(
    private shell: RunnerShell,
    private promptBuilder: { build: (implFindings: unknown[]) => string },
  ) {}

  async annotate(
    implFindings: unknown[],
    workerOutputForGrounding: string,
    opts: { systemPrompt: string; cwd: string; maxTurns: number },
  ): Promise<AnnotatorOutput> {
    const userMessage = this.promptBuilder.build(implFindings);
    let result;
    try {
      result = await this.shell.run({
        ...opts,
        userMessage,
        toolDefinitions: [],
      });
    } catch {
      return { verdict: 'error', findings: [] };
    }
    return this.parse(
      result.finalAssistantText,
      workerOutputForGrounding,
      implFindings.length,
    );
  }

  private parse(
    text: string,
    workerOutput: string,
    expectedCount: number,
  ): AnnotatorOutput {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) return { verdict: 'error', findings: [] };
    let obj: any;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      return { verdict: 'error', findings: [] };
    }
    if (!Array.isArray(obj.findings))
      return { verdict: 'error', findings: [] };
    const findings: AnnotatedFinding[] = obj.findings.map(
      (f: any, i: number) => {
        const rawConf = f.annotatorConfidence;
        const numeric =
          typeof rawConf === 'number' && Number.isFinite(rawConf)
            ? rawConf
            : 0;
        return {
          id: f.id ?? `F${i + 1}`,
          severity: f.severity,
          claim: f.claim,
          evidence: f.evidence,
          evidenceGrounded:
            typeof f.evidenceGrounded === 'boolean'
              ? f.evidenceGrounded
              : workerOutput.includes(f.evidence ?? ''),
          suggestion: f.suggestion,
          annotatorConfidence: Math.max(
            0,
            Math.min(100, Math.round(numeric)),
          ),
        };
      },
    );
    if (findings.length !== expectedCount) {
      throw new Error(
        `AnnotatorEngine dropped findings: expected ${expectedCount}, got ${findings.length}`,
      );
    }
    return { verdict: 'annotated', findings };
  }
}
