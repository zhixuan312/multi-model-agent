import type { RunnerShell } from '../runner-shell/shell.js';
import { buildAuditQualityPrompt } from './quality-only-prompts.js';

export interface AnnotatorInput {
  workerOutput: string;
  brief: string;
  cwd: string;
}

export interface AnnotatorOutput {
  verdict: 'annotated' | 'error';
  annotatedText: string;
}

export class AnnotatorEngine {
  constructor(private shell: RunnerShell) {}

  async annotate(input: AnnotatorInput): Promise<AnnotatorOutput> {
    const prompt = buildAuditQualityPrompt({
      workerOutput: input.workerOutput,
      brief: input.brief,
    });
    const result = await this.shell.run({
      systemPrompt: prompt,
      userMessage: 'Annotate the findings above.',
      toolDefinitions: [],
      maxTurns: 5,
      cwd: input.cwd,
    });
    return {
      verdict: result.errorCode ? 'error' : 'annotated',
      annotatedText: result.finalAssistantText ?? '',
    };
  }
}
