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

import type { Session } from '../../types/run-result.js';
import { parseFindings, type Finding } from '../findings-parser.js';
import { HUMAN_LABEL } from '../stage-labels.js';

interface Criterion {
  id: string;
  title: string;
  description: string;
}

export interface ReadRouteImplementerInput {
  session: Session;
  cachedPrefix: string;
  criteria: readonly Criterion[];
  buildSuffix: (c: Criterion) => string;
}

export interface ReadRouteImplementerResult {
  findings: Finding[];
  criteriaErrors: { criterionId: string; error: string }[];
  usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
  turns: number;
  costUSD: number | null;
  durationMs: number;
  /** Joined per-criterion narrative — used by downstream parsers that
   *  read raw text (annotator fallback, terminal-block renderers). */
  synthesizedOutput: string;
}

/**
 * Run the sequential read-route criteria loop on a single session.
 * Prefix is sent once with the first criterion (cached after); each
 * subsequent criterion sends only its suffix and benefits from the
 * model's prior tool calls retained in the session.
 */
export async function runReadRouteImplementer(
  input: ReadRouteImplementerInput,
): Promise<ReadRouteImplementerResult> {
  const findings: Finding[] = [];
  const criteriaErrors: { criterionId: string; error: string }[] = [];
  const perCriterionOutputs: string[] = [];

  let totalInput = 0, totalOutput = 0, totalCachedRead = 0, totalCachedNonRead = 0;
  let totalCost: number | null = null;
  let totalDuration = 0;
  let totalTurns = 0;

  for (let i = 0; i < input.criteria.length; i++) {
    const c = input.criteria[i]!;
    const prompt = i === 0
      ? `${input.cachedPrefix}\n\n${input.buildSuffix(c)}`
      : input.buildSuffix(c);
    try {
      const turn = await input.session.send(prompt, { stageLabel: HUMAN_LABEL.implementing });
      findings.push(...parseFindings(turn.output, c.id));
      perCriterionOutputs.push(`--- ${c.title} (criterion ${c.id}) ---\n${turn.output}`);
      totalInput += turn.usage?.inputTokens ?? 0;
      totalOutput += turn.usage?.outputTokens ?? 0;
      totalCachedRead += turn.usage?.cachedReadTokens ?? 0;
      totalCachedNonRead += turn.usage?.cachedNonReadTokens ?? 0;
      totalDuration += turn.durationMs ?? 0;
      totalTurns += turn.turns ?? 1;
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

  return {
    findings,
    criteriaErrors,
    usage: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedReadTokens: totalCachedRead,
      cachedNonReadTokens: totalCachedNonRead,
    },
    turns: totalTurns,
    costUSD: totalCost,
    durationMs: totalDuration,
    synthesizedOutput: perCriterionOutputs.join('\n\n'),
  };
}
