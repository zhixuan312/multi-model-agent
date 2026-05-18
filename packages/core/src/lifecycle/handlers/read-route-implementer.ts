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
import type { FindingsOutcomeKind } from '../../reporting/findings-outcome.js';
import { aggregateOutcomes } from '../../reporting/findings-outcome.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { buildWarmFollowupMessage } from '../warm-followup.js';

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
  legalOutcomes: readonly FindingsOutcomeKind[];
  /** Optional sink for dropped/malformed Finding warnings (parser-side).
   *  Pass an envelope-bound sink so silent parser drops become visible in
   *  validationWarnings — otherwise a worker's malformed Findings vanish
   *  without trace. Defaults to no-op (back-compat with tests). */
  warnSink?: (event: string, data: Record<string, unknown>) => void;
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
  findingsOutcome: FindingsOutcomeKind;
  findingsOutcomeReason: string | null;
  outcomeInferred: boolean;
  outcomeMalformed: boolean;
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
  const perCriterionOutcomes: FindingsOutcomeKind[] = [];
  const perCriterionReasons: (string | null)[] = [];

  let totalInput = 0, totalOutput = 0, totalCachedRead = 0, totalCachedNonRead = 0;
  let totalCost: number | null = null;
  let totalDuration = 0;
  let totalTurns = 0;

  for (let i = 0; i < input.criteria.length; i++) {
    const c = input.criteria[i]!;
    const suffix = input.buildSuffix(c);
    // Turn 0 sends cachedPrefix + suffix (cold open into the implementer's
    // session). Turns 1..N go through the warm-follow-up helper so the
    // model knows the document + earlier tool results are already in
    // thread history and skips re-grepping them.
    const prompt = i === 0
      ? `${input.cachedPrefix}\n\n${suffix}`
      : buildWarmFollowupMessage(suffix);
    try {
      const turn = await input.session.send(prompt, { stageLabel: HUMAN_LABEL.implementing });
      totalInput += turn.usage?.inputTokens ?? 0;
      totalOutput += turn.usage?.outputTokens ?? 0;
      totalCachedRead += turn.usage?.cachedReadTokens ?? 0;
      totalCachedNonRead += turn.usage?.cachedNonReadTokens ?? 0;
      totalDuration += turn.durationMs ?? 0;
      totalTurns += turn.turns ?? 1;
      if (turn.costUSD !== null && turn.costUSD !== undefined) {
        totalCost = (totalCost ?? 0) + turn.costUSD;
      }
      if (turn.terminationReason !== 'ok') {
        // Cap hit, stall, error, etc. — the turn produced no usable findings
        // even though it did not throw. Record as a criterion error so the
        // route's headline + status correctly reflect partial completion.
        criteriaErrors.push({
          criterionId: c.id,
          error: turn.errorMessage ?? `turn ended with ${turn.terminationReason}`,
        });
        continue;
      }
      const result = parseFindings(turn.output, c.id, input.legalOutcomes, input.warnSink);
      findings.push(...result.findings);
      perCriterionOutputs.push(`--- ${c.title} (criterion ${c.id}) ---\n${turn.output}`);
      perCriterionOutcomes.push(result.outcome);

      // Extract reason for not_applicable outcomes
      if (result.outcome === 'not_applicable') {
        const reasonMatch = turn.output.match(/^## Outcome\s*\n\s*not_applicable\s*—\s*(.+)$/m);
        perCriterionReasons.push(reasonMatch ? reasonMatch[1].trim() : null);
      } else {
        perCriterionReasons.push(null);
      }
    } catch (err) {
      criteriaErrors.push({
        criterionId: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Aggregate outcomes by precedence: found > not_applicable > clean
  const aggregatedOutcome: FindingsOutcomeKind = perCriterionOutcomes.length > 0
    ? aggregateOutcomes(perCriterionOutcomes)
    : 'clean';

  // Aggregate reasons: concatenate not_applicable reasons with semicolon separator
  const aggregatedReason: string | null = aggregatedOutcome === 'not_applicable'
    ? perCriterionReasons.filter((r): r is string => r !== null).join('; ')
    : null;

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
    findingsOutcome: aggregatedOutcome,
    findingsOutcomeReason: aggregatedReason,
    outcomeInferred: false,
    outcomeMalformed: false,
  };
}
