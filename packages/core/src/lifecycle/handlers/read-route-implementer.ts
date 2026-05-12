// v4.4.x — Read-route Implementing stage.
//
// One complex session per task, sequential for-loop over criteria.
// Each iteration: build a per-criterion prompt, send, parse findings.
// Earlier criteria's tool results carry forward in the session context
// so the model doesn't re-discover the same files across criteria —
// the token win over the old N-parallel-sub-workers approach.
//
// Failures are recorded as criteriaErrors entries (not findings) so
// the read-route findings list stays clean of internal-error noise.

import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import { parseFindings, type Finding } from '../findings-parser.js';
import { HUMAN_LABEL } from '../stage-labels.js';

interface Criterion {
  id: string;
  title: string;
  description: string;
}

export interface ReadRouteImplementerInput {
  criteria: readonly Criterion[];
  buildSuffix: (c: Criterion) => string;
  route: string;
}

export function makeReadRouteImplementer(input: ReadRouteImplementerInput) {
  return async function readRouteImplementer(state: LifecycleState): Promise<void> {
    const ctx = (state as { executionContext?: ExecutionContext }).executionContext;
    if (!ctx) return;
    const session = ctx.getSession('complex');

    const findings: Finding[] = [];
    const criteriaErrors: { criterionId: string; error: string }[] = [];

    let totalInput = 0, totalOutput = 0, totalCachedRead = 0, totalCachedNonRead = 0;
    let totalCost: number | null = null;
    let totalDuration = 0;

    for (const c of input.criteria) {
      try {
        const turn = await session.send(input.buildSuffix(c), { stageLabel: HUMAN_LABEL.implementing });
        findings.push(...parseFindings(turn.output, c.id));
        totalInput += turn.usage?.inputTokens ?? 0;
        totalOutput += turn.usage?.outputTokens ?? 0;
        totalCachedRead += turn.usage?.cachedReadTokens ?? 0;
        totalCachedNonRead += turn.usage?.cachedNonReadTokens ?? 0;
        totalDuration += turn.durationMs ?? 0;
        if (turn.costUSD !== null && turn.costUSD !== undefined) {
          totalCost = (totalCost ?? 0) + turn.costUSD;
        }
      } catch (err) {
        criteriaErrors.push({
          criterionId: c.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    (state as { lastRunResult?: unknown }).lastRunResult = {
      output: '',
      status: 'ok' as const,
      findings,
      criteriaErrors,
      filesChanged: [],
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      turns: input.criteria.length,
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cachedReadTokens: totalCachedRead,
        cachedNonReadTokens: totalCachedNonRead,
      },
      outputIsDiagnostic: false,
      escalationLog: [],
      costUSD: totalCost,
      durationMs: totalDuration,
    };
  };
}
