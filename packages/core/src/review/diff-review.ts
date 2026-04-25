import type { VerifyStageResult } from '../run-tasks/verify-stage.js';

export type DiffReviewConcern = {
  source: 'diff_review';
  severity: 'low' | 'medium' | 'high';
  message: string;
};

export type DiffReviewVerdict =
  | { kind: 'approve'; concerns: [] }
  | { kind: 'concerns'; concerns: DiffReviewConcern[] }
  | { kind: 'reject'; message: string };

export interface DiffReviewInput {
  cwd: string;
  diff: string;
  diffTruncated: boolean;
  verification: VerifyStageResult;
  worker: { call: (prompt: string) => Promise<{ output: string }> };
}

const PROMPT_TEMPLATE = (i: DiffReviewInput) => `
You are reviewing a mechanical refactor in a single pass. No rework loop is available.

Working directory: ${i.cwd}
Verification: ${i.verification.status}
${i.verification.steps.map((s) => `- ${s.command} → ${s.status}`).join('\n')}

Diff${i.diffTruncated ? ' (TRUNCATED at 64 KB — you may not approve cleanly)' : ''}:
\`\`\`diff
${i.diff}
\`\`\`

Reply with EXACTLY one of:
- APPROVE
- CONCERNS: <comma-separated short concern messages>
- REJECT: <one-line reason>
`;

export async function runDiffReview(input: DiffReviewInput): Promise<DiffReviewVerdict> {
  const prompt = PROMPT_TEMPLATE(input);
  const { output } = await input.worker.call(prompt);
  const trimmed = output.trim();

  if (trimmed === 'APPROVE') return { kind: 'approve', concerns: [] };

  if (trimmed.startsWith('CONCERNS:')) {
    const msgs = trimmed
      .slice('CONCERNS:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      kind: 'concerns',
      concerns: msgs.map((m) => ({
        source: 'diff_review' as const,
        severity: 'medium' as const,
        message: m,
      })),
    };
  }

  if (trimmed.startsWith('REJECT:')) {
    return { kind: 'reject', message: trimmed.slice('REJECT:'.length).trim() };
  }

  return {
    kind: 'concerns',
    concerns: [
      {
        source: 'diff_review',
        severity: 'high',
        message: `unparseable verdict: ${trimmed.slice(0, 200)}`,
      },
    ],
  };
}
