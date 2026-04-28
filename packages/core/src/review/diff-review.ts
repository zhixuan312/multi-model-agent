import type { VerifyStageResult } from '../run-tasks/verify-stage.js';
import type { SkippedReviewResult } from './skipped-result.js';

export type DiffReviewConcern = {
  source: 'diff_review';
  severity: 'low' | 'medium' | 'high';
  message: string;
};

export type DiffReviewVerdict =
  | { kind: 'approve'; status?: 'approved'; concerns: [] }
  | { kind: 'concerns'; status?: 'changes_required'; concerns: DiffReviewConcern[] }
  | { kind: 'reject'; status?: 'changes_required'; message: string }
  | { kind: 'transport_failure'; status: 'api_error' | 'network_error' | 'timeout' | 'api_aborted'; concerns: DiffReviewConcern[]; reason?: string };

export type DiffReviewOrSkipped = DiffReviewVerdict | SkippedReviewResult;

export interface DiffReviewInput {
  cwd: string;
  diff: string;
  diffTruncated: boolean;
  verification: VerifyStageResult;
  worker: {
    call: (
      prompt: string,
      opts?: { abortSignal?: AbortSignal; timeoutMs?: number },
    ) => Promise<{ output: string; status?: string }>;
  };
  taskDeadlineMs?: number;
  abortSignal?: AbortSignal;
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
  if (input.abortSignal?.aborted) {
    return { kind: 'transport_failure', status: 'api_aborted', concerns: [], reason: 'aborted before worker call' };
  }
  const remaining = input.taskDeadlineMs !== undefined
    ? Math.max(1, input.taskDeadlineMs - Date.now())
    : undefined;
  const prompt = PROMPT_TEMPLATE(input);
  const result = await input.worker.call(prompt, {
    abortSignal: input.abortSignal,
    timeoutMs: remaining,
  });
  if (result.status === 'api_error' || result.status === 'network_error' || result.status === 'timeout' || result.status === 'api_aborted') {
    return { kind: 'transport_failure', status: result.status, concerns: [] };
  }
  const trimmed = result.output.trim();

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
