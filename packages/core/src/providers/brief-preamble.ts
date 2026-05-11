// Minimal stage-instruction prefix used as part of every `session.send()`
// instruction text. The SDK ships its own agent-operating system prompt;
// THIS file is for content the BRIEF needs to carry across all providers
// (commit-block schema, output-format hints). It is NOT an agent-loop
// system prompt — those live in the SDKs.
//
// Replaces the agent-loop portion of `prevention.ts` in v4.4 (Task 24
// deletes the loop-system-prompt body of prevention.ts; buildFormatConstraintSuffix
// is preserved here so existing callers don't break during the migration).

import type { FormatConstraints } from '../types/task-spec.js';

export const COMMIT_BLOCK_GUIDANCE = [
  'If you wrote, modified, or deleted files, your structured report MUST include a `commit:` block as a JSON object with these fields:',
  '',
  '  {',
  '    "type": "feat" | "fix" | "refactor" | "test" | "docs" | "chore" | "style",',
  '    "scope": "<optional, 1-24 chars: lowercase letters, digits, dot, underscore, slash, hyphen; must start with letter or digit>",',
  '    "subject": "<1-50 chars, lowercase first letter, no trailing colon, no leading/trailing whitespace>",',
  '    "body": "<optional multi-paragraph plain text explaining WHY>"',
  '  }',
  '',
  'Examples:',
  '  type: "feat", scope: "core", subject: "add x"',
  '  type: "refactor", scope: "lifecycle", subject: "extract Y from Z"',
  '  type: "fix", subject: "guard against undefined"',
  '',
  "Do NOT write narrative (\"Now I'm going to...\") in the subject.",
  '',
  'If you did not write any files, omit the commit block entirely.',
].join('\n');

export function buildFormatConstraintSuffix(constraints: FormatConstraints): string {
  if (!constraints.inputFormat && !constraints.outputFormat) return '';
  const parts: string[] = [];
  if (constraints.inputFormat) parts.push(`input format: ${constraints.inputFormat}`);
  if (constraints.outputFormat) parts.push(`output format: ${constraints.outputFormat}`);
  return '\n\n' + parts.join(' ');
}
