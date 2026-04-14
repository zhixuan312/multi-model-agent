import type { Effort } from './types.js';

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const ACTION_VERB_RE = /\b(edit|modify|update|change|fix|refactor|replace)\b/i;
const FILE_PATH_RE = /\b[\w\-./]+\.(ts|js|tsx|jsx|py|rs|go|java|rb|cpp|c|h)\b/;

/**
 * Infer effort from task prompt shape. Returns undefined when no heuristic
 * matches (caller falls back to provider config default). Exported for testing.
 */
export function inferEffort(prompt: string): Effort | undefined {
  // Heuristic 1: Large code block → exact-write task → low effort
  const codeBlocks = prompt.match(CODE_BLOCK_RE) ?? [];
  for (const block of codeBlocks) {
    const lines = block.split('\n').length - 2; // subtract opening/closing fence lines
    if (lines > 20) return 'low';
  }

  // Heuristic 2: File references + action verbs → discovery task → medium effort
  if (FILE_PATH_RE.test(prompt) && ACTION_VERB_RE.test(prompt)) {
    return 'medium';
  }

  return undefined;
}
