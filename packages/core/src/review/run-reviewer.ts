// Thin wrapper that runs one reviewer-tier LLM turn with 3-attempt transport-retry policy.
// Spec §4.6: transport failures (network, 5xx, model gateway, timeout) → 3 total attempts
// with backoff 0s → 1s → 2s. Non-transport caps (cost_cap, turn_cap, sandbox) → no retry.

import type { ExecutionContext } from '../lifecycle/lifecycle-context.js';

export type RunReviewerInput = {
  prompt: string;
  ctx: ExecutionContext;
  reviewer: 'spec' | 'quality';
};

export type RunReviewerResult =
  | { kind: 'ok'; text: string; costUSD: number | null; turnsUsed: number; ms: number }
  | { kind: 'transport_error'; message: string; ms: number };

export async function runReviewerTurn(input: RunReviewerInput): Promise<RunReviewerResult> {
  const t0 = Date.now();
  const backoffMs = [0, 1000, 2000]; // attempt 1: no backoff; 2: 1s; 3: 2s
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (backoffMs[attempt] > 0) await sleep(backoffMs[attempt]);
    try {
      const session = input.ctx.getSession('standard');
      const r = await session.send(input.prompt);
      return {
        kind: 'ok',
        text: r.output ?? '',
        costUSD: r.costUSD ?? null,
        turnsUsed: r.turns ?? 1,
        ms: Date.now() - t0,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // Only retry on transport-class errors; cost_cap / turn_cap / sandbox are non-retryable.
      if (!/transport|network|5\d\d|timeout/i.test(lastErr)) break;
    }
  }
  return { kind: 'transport_error', message: lastErr || 'reviewer failed', ms: Date.now() - t0 };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }