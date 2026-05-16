// packages/core/src/providers/run-annotator-turn.ts
//
// Thin helper that runs a single annotator LLM turn through the session.
// Implements the 3-attempt transport retry policy from spec §4.6.
// Used by the annotator handler when the LLM judge layer is enabled
// (config.enableLLMAnnotate / default-on path); falls back to the
// deterministic parser when this helper returns transport_error.

import type { ExecutionContext } from '../lifecycle/lifecycle-context.js';

export type RunAnnotatorInput = {
  prompt: string;
  ctx: ExecutionContext;
  tier?: 'standard' | 'complex';     // default 'standard'
};

export type RunAnnotatorResult =
  | { kind: 'ok'; text: string; costUSD: number | null; turnsUsed: number; ms: number; model: string | null }
  | { kind: 'transport_error'; message: string; ms: number };

const TRANSPORT_RETRY_RE = /transport|network|5\d\d|timeout|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed/i;
const BACKOFF_MS = [0, 1000, 2000];

export async function runAnnotatorTurn(input: RunAnnotatorInput): Promise<RunAnnotatorResult> {
  const t0 = Date.now();
  let lastErr = '';
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    if (BACKOFF_MS[attempt] > 0) await sleep(BACKOFF_MS[attempt]);
    try {
      const session = input.ctx.getSession(input.tier ?? 'standard');
      const turn = await session.send(input.prompt, { stageLabel: 'annotate' });
      return {
        kind: 'ok',
        text: turn.output ?? '',
        costUSD: typeof turn.costUSD === 'number' ? turn.costUSD : null,
        turnsUsed: turn.turns ?? 1,
        ms: Date.now() - t0,
        model: typeof turn.model === 'string' ? turn.model : null,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (!TRANSPORT_RETRY_RE.test(lastErr)) break;          // non-transport: don't retry
    }
  }
  return { kind: 'transport_error', message: lastErr || 'annotator turn failed', ms: Date.now() - t0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
