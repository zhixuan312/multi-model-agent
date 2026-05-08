import { REVIEWER_AWARENESS_AP } from '../../review/templates/finding-criteria.js';

export type ReviewPolicy = 'full' | 'quality_only' | 'diff_only' | 'none';

const SCOPE_CONTRACT = `Stay scoped to the explicit task description. Do NOT enlarge the task. If the task references files, read those files first; do not enumerate adjacent ones.`;

export function compileDelegatePrompt(input: { prompt: string; filePaths?: string[] }): string {
  const filePathsClause = input.filePaths && input.filePaths.length > 0
    ? `\n\nFILE CONSTRAINT: write your code to exactly these file path(s), no others, no renames: ${input.filePaths.map((p) => `\`${p}\``).join(', ')}.`
    : '';
  return `${input.prompt}\n\n${SCOPE_CONTRACT}${filePathsClause}\n\n${REVIEWER_AWARENESS_AP}`;
}
