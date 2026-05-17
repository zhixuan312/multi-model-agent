// Thin wrapper that runs one reviewer-tier LLM turn with 3-attempt transport-retry policy.
// Spec §4.6: transport failures (network, 5xx, model gateway, timeout) → 3 total attempts
// with backoff 0s → 1s → 2s. Non-transport caps (turn_cap, sandbox) → no retry.

import type { ExecutionContext } from '../lifecycle/lifecycle-context.js';
import type { AgentType } from '../types.js';
import { HUMAN_LABEL } from '../lifecycle/stage-labels.js';

export type RunReviewerInput = {
  prompt: string;
  ctx: ExecutionContext;
  reviewer: 'spec' | 'quality';
  /**
   * The implementer's tier. The reviewer runs on the OPPOSITE tier as a
   * "second-opinion needs a different perspective" policy:
   *   implementer=standard → reviewer=complex (capable reviewer of cheap work)
   *   implementer=complex  → reviewer=standard (cheap sanity check of expensive work)
   * If the inverted tier has no provider configured, falls back to the
   * implementer tier and records a `validation_warnings` diagnostic upstream.
   */
  implementerTier: AgentType;
};

/**
 * Cross-tier inversion: reviewer tier is the opposite of the implementer's.
 * Exported so callers can compute the tier independently (e.g. for logging
 * or for the `mergeStageStats` call in review-handler.ts).
 */
export function invertedReviewerTier(implementerTier: AgentType): AgentType {
  return implementerTier === 'complex' ? 'standard' : 'complex';
}

export type RunReviewerResult =
  | {
      kind: 'ok';
      text: string;
      costUSD: number | null;
      turnsUsed: number;
      ms: number;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cachedReadTokens: number;
      cachedNonReadTokens: number;
    }
  | { kind: 'transport_error'; message: string; ms: number };

export async function runReviewerTurn(input: RunReviewerInput): Promise<RunReviewerResult> {
  const t0 = Date.now();
  const backoffMs = [0, 1000, 2000]; // attempt 1: no backoff; 2: 1s; 3: 2s
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (backoffMs[attempt] > 0) await sleep(backoffMs[attempt]);
    try {
      // Cross-tier inversion. If the inverted tier has no provider
      // configured (single-tier deployments), fall back to the implementer
      // tier so the reviewer can still run. The fallback is observable
      // via the resolved `session.model` carried into the wire payload.
      const desired = invertedReviewerTier(input.implementerTier);
      const providers = (input.ctx as { providers?: Partial<Record<AgentType, unknown>> }).providers;
      const tierToUse: AgentType = providers && providers[desired] ? desired : input.implementerTier;
      const session = input.ctx.getSession(tierToUse);
      const r = await session.send(input.prompt, { stageLabel: HUMAN_LABEL.review });
      return {
        kind: 'ok',
        text: r.output ?? '',
        costUSD: r.costUSD ?? null,
        turnsUsed: r.turns ?? 1,
        ms: Date.now() - t0,
        model: typeof (r as { model?: string }).model === 'string'
          ? (r as { model?: string }).model!
          : null,
        inputTokens: r.usage?.inputTokens ?? 0,
        outputTokens: r.usage?.outputTokens ?? 0,
        cachedReadTokens: r.usage?.cachedReadTokens ?? 0,
        cachedNonReadTokens: r.usage?.cachedNonReadTokens ?? 0,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // Only retry on transport-class errors; turn_cap / sandbox are non-retryable.
      if (!/transport|network|5\d\d|timeout/i.test(lastErr)) break;
    }
  }
  return { kind: 'transport_error', message: lastErr || 'reviewer failed', ms: Date.now() - t0 };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
