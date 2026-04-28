import type { TaskSpec } from '../../types.js';
import type { Input } from '../../tool-schemas/investigate.js';
import { OUTPUT_CONTRACT_CLAUSES } from '../resolve.js';

export interface ResolvedContextBlock {
  id: string;
  content: string;
}


export function compileInvestigate(
  input: Input,
  resolvedContextBlocks: ResolvedContextBlock[],
  canonicalizedFilePaths: string[],
  relativeFilePathsForPrompt: string[],
  cwd: string,
): TaskSpec & { route: 'investigate_codebase'; originalInput: Record<string, unknown>; question: string } {
  if (canonicalizedFilePaths.length !== relativeFilePathsForPrompt.length) {
    throw new Error('compileInvestigate: canonicalizedFilePaths and relativeFilePathsForPrompt must be the same length');
  }

  const promptParts: string[] = [];
  promptParts.push(OUTPUT_CONTRACT_CLAUSES['investigate_codebase']!);
  for (const block of resolvedContextBlocks) {
    promptParts.push(block.content);
  }
  if (relativeFilePathsForPrompt.length > 0) {
    promptParts.push(
      'Anchor paths to start from (you may also read beyond these):\n' +
      relativeFilePathsForPrompt.map(p => `- ${p}`).join('\n'),
    );
  }
  promptParts.push(`Question: ${input.question}`);
  if (resolvedContextBlocks.length > 0) {
    promptParts.push(
      'A prior investigation report is provided as context above. Refine or extend that investigation. In your output, mark which prior unresolved questions you resolved this round and which remain open.',
    );
  }

  return {
    route: 'investigate_codebase',
    prompt: promptParts.join('\n\n'),
    originalInput: {
      ...input,
      filePaths: canonicalizedFilePaths,
    } as unknown as Record<string, unknown>,
    question: input.question,
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only',
    tools: input.tools ?? 'readonly',
    filePaths: canonicalizedFilePaths,
    sandboxPolicy: 'cwd-only',
    cwd,
  } as unknown as TaskSpec & { route: 'investigate_codebase'; originalInput: Record<string, unknown>; question: string };
}
