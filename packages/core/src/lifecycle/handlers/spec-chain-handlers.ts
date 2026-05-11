import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { pickReviewer, pickEscalation } from '../../escalation/policy.js';
import type { ReviewerCallResult, ReviewRoute } from '../../review/reviewer-engine.js';
import { ReviewerParseError } from '../../review/reviewer-engine.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import {
  runWithFallback,
  TRANSPORT_FAILURES,
  isReviewTransportFailure,
  makeSyntheticRunResult,
  type UnavailableMap,
} from '../../escalation/fallback.js';
import { makeSkippedReviewResult, type SkippedReviewResult } from '../../review/skipped-result.js';
import { makeRunnerShell } from '../../providers/make-runner-shell.js';
import { mergeStageStats, replaceLastRunResultPreservingTrackers } from '../merge-stage-stats.js';

/**
 * Spec-chain handlers (#45 Step 4a).
 *
 * Six StagePlan rows are wired here:
 *   - 4.1 spec_review_round_1
 *   - 4.2 rework_for_spec_round_1
 *   - 4.3 spec_review_round_2
 *   - 4.4 rework_for_spec_round_2
 *   - 4.5 spec_review_round_3
 *   - 4.6 settle_spec_chain
 *
 * Each review handler wraps the shared `runSpecReviewRound` helper that
 * picks the reviewer per spec C9 (rotation timing: tier swap at round 3 /
 * attemptIndex 2), pulls the implementer report from state.lastRunResult,
 * and writes the round's verdict slot.
 *
 * Each rework handler builds a rework brief from the prior round's verdict
 * and delegates via pickEscalation. Per #45 Step 0:
 *   - Spec rework_1 uses attemptIndex 1 (specChainAttemptIndex initialized
 *     to 1 after the initial impl).
 *   - Spec rework_2 uses attemptIndex 2.
 *
 * Settle handler aggregates the three round verdicts into state.specChainPassed
 * per the cascade rule: any 'approved' wins; 'changes_required' through round
 * 3 ⇒ false; 'error' is hard-fail (terminal).
 *
 * Idempotency: each handler skips when its verdict slot is already
 * populated. Prevents re-firing reviewer turns on retry paths.
 *
 * Defensive no-ops: when state.task, state.executionContext, or
 * state.lastRunResult is missing, the handler short-circuits.
 */

interface ReviewRoundInput {
  state: LifecycleState;
  ctx: ExecutionContext;
  round: 1 | 2 | 3;
}

/**
 * Build a surgical rework prompt — frames this round as "apply the
 * reviewer's targeted instructions to your prior work", not "redo the
 * task from scratch".
 *
 * Cheap workers respond to "redo with these concerns in mind" by
 * re-reading every file and paraphrasing again (observed 2026-05-11
 * MiniMax-M2.7 dispatch: 28 minutes, 100 tool calls, 2 writes). They
 * respond much better to "here are mechanical patches to apply".
 *
 * The reviewer (per the new spec-review template) writes concerns as
 * concrete instructions — "in <file> line N, replace X with Y verbatim
 * from plan step M". This builder makes those instructions the prompt's
 * focal content. The original task prompt stays at the top for context,
 * but the mental model is "apply the patch list", not "re-implement".
 */
function buildSpecReworkPrompt(originalPrompt: string, priorConcerns: string[], priorDiff: string, round: number): string {
  const concernsList = priorConcerns.length > 0
    ? priorConcerns.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(no specific concerns recorded — re-read your prior diff above and the plan section in the original task; ensure verbatim match.)';

  // Cap the prior diff at 30 KB to keep prompt size bounded. Real
  // execute-plan tasks rarely exceed this; if they do, the worker can
  // still read the files for the missing context.
  const DIFF_CAP_BYTES = 30 * 1024;
  let diffBlock = '';
  if (priorDiff.length > 0) {
    const truncated = Buffer.byteLength(priorDiff, 'utf8') > DIFF_CAP_BYTES;
    const diff = truncated
      ? Buffer.from(priorDiff, 'utf8').subarray(0, DIFF_CAP_BYTES).toString('utf8') + '\n[... diff truncated at 30KB; read affected files for the missing tail ...]'
      : priorDiff;
    diffBlock = [
      '# Your prior work (cumulative diff from your previous attempts)',
      '',
      'This is what you wrote. The files on disk match this diff exactly — you do NOT need to re-read them. Edit them directly using the targeted instructions below.',
      '',
      '```diff',
      diff,
      '```',
      '',
    ].join('\n');
  }

  return [
    originalPrompt,
    '',
    `# Rework round ${round} — apply the reviewer's targeted instructions`,
    '',
    'You implemented a previous attempt. The reviewer compared your diff against the plan section and produced the targeted fix list below. Apply each item mechanically to your prior work.',
    '',
    diffBlock,
    'How to think about this round (different from the initial implementation):',
    '- This is NOT "re-implement the task from scratch". You already wrote files; the diff above shows what you produced.',
    '- DO NOT re-read files first. Your prior diff above shows the current on-disk state; trust it and edit directly.',
    '- Each concern below is a concrete instruction: where to apply, what verbatim text to use, what action (replace / add / remove / copy from plan step N).',
    '- Apply each instruction as written. Do NOT redesign. Do NOT rewrite parts the reviewer did not flag.',
    '- After applying every instruction, run the verification commands the plan listed and report PASS/FAIL in your summary.',
    '- If an instruction is genuinely ambiguous or you cannot find the location it references: note that specific item in your summary as "could not apply: <reason>" — do NOT bail on the whole task.',
    '',
    "# Reviewer's targeted instructions (apply each)",
    concernsList,
    '',
    '# Turn budget',
    'Complete this rework in 3-5 tool calls: one edit per file the reviewer asked you to change, plus the verify command. If you find yourself reading the same file twice, STOP and edit — you already have the content from your prior diff above.',
    '',
    '# Action',
    'Edit the files to apply the instructions above. Do not redesign. Do not rewrite untouched code. After editing, run the plan-listed verification commands and include their output under "Self-verification" in your summary. Then report briefly: which instructions you applied, which (if any) you could not, and the verification results.',
  ].join('\n');
}

async function runSpecReviewRound(input: ReviewRoundInput): Promise<ReviewerCallResult | null> {
  const { state, ctx, round } = input;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return null;

  const baseTier: AgentType = ctx.assignedTier;
  const reviewerTier = pickReviewer({ loop: 'spec', attemptIndex: round - 1, baseTier });

  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  state.specUnavailable ??= new Map() as UnavailableMap;
  const specUnavailable: UnavailableMap = state.specUnavailable;

  // Tool sweep #6: produce the cumulative diff so the reviewer sees
  // the actual code change, not just the worker's text claim. Empty
  // string when no diff tracker (read-only routes) or no changes.
  let cumulativeDiff = '';
  if (state.diffTracker) {
    try {
      cumulativeDiff = await state.diffTracker.cumulativeDiff();
    } catch {
      // Diff failures shouldn't block review. Falls back to text-only.
    }
  }
  const priorConcerns = Array.isArray(state.priorSpecConcerns) ? state.priorSpecConcerns : [];

  const reviewerCall = await runWithFallback<ReviewerCallResult | SkippedReviewResult>({
    assigned: reviewerTier,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: specUnavailable,
    isTransportFailure: (r) => isReviewTransportFailure(r as { status?: string }),
    getStatus: (r) => (r as { status?: RunResult['status'] }).status,
    makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
    call: async (provider, usedTier) => {
      const shell = makeRunnerShell(provider);
      const engine = ctx.reviewerEngine;
      if (!engine) throw new Error('reviewerEngine not configured');
      try {
        return engine.runSpec(shell, {
          workerOutput: last.output,
          brief: task.prompt ?? '',
          cwd: ctx.cwd,
          route: (state.route ?? ctx.route) as ReviewRoute,
          diff: cumulativeDiff,
          priorConcerns,
          ...(task.planContext ? { planContext: task.planContext } : {}),
          abortSignal: ctx.stall.controller.signal,
          deadlineMs: ctx.timing.deadlineMs,
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          tier: usedTier,
          stageLabel: 'Spec review',
        });
      } catch (err) {
        if (err instanceof ReviewerParseError) {
          return { verdict: 'error' as const, concerns: [] } as unknown as ReviewerCallResult;
        }
        throw err;
      }
    },
  });

  if (reviewerCall.bothUnavailable) return null;
  const out = reviewerCall.result;
  if ('status' in out && out.status === 'skipped') return null;
  return out as ReviewerCallResult;
}

async function runSpecRework(input: ReviewRoundInput): Promise<RunResult | null> {
  const { state, ctx, round } = input;
  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const attemptIndex = round - 1; // rework_1 → attemptIndex 1, rework_2 → attemptIndex 2
  const baseTier: AgentType = ctx.assignedTier;
  const decision = pickEscalation({ loop: 'spec', attemptIndex, baseTier });

  state.specChainAttemptIndex = attemptIndex;
  state.specUnavailable ??= new Map() as UnavailableMap;
  const specUnavailable: UnavailableMap = state.specUnavailable;

  // Surgical rework prompt — frame this round as "apply the reviewer's
  // targeted instructions to your prior work", not "redo the task".
  // Cheap workers respond to "redo" by re-reading every file and
  // paraphrasing again; they respond to "apply these patches" by editing.
  // Reviewer concerns (per the new spec-review template) are written as
  // concrete instructions: "in <file> line N, replace X with Y verbatim
  // from plan step M". The reworker just applies them.
  //
  // 4.2.3+: also include the worker's prior cumulative diff inline.
  // Without it, cheap models restart-loop on "let me read both files
  // first" turn after turn (observed 2026-05-11 MiniMax-M2.7 A7.1
  // dispatch: 100+ tool calls in rework round 1, zero edits). With the
  // diff inline, the worker sees its prior state directly and can edit
  // without re-reading.
  const priorConcerns = (state.priorSpecConcerns as string[] | undefined) ?? [];
  let priorDiff = '';
  if (state.diffTracker) {
    try {
      priorDiff = await state.diffTracker.cumulativeDiff();
    } catch {
      // Diff failures shouldn't block rework; fall back to no inline diff.
    }
  }
  const reworkPrompt = buildSpecReworkPrompt(task.prompt ?? '', priorConcerns, priorDiff, round);
  const reworkTask: TaskSpec = { ...task, prompt: reworkPrompt };

  const reworkCall = await runWithFallback<RunResult>({
    assigned: decision.impl,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: specUnavailable,
    isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.incompleteReason === undefined,
    getStatus: (r) => r.status,
    makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'),
    call: (provider, usedTier) =>
      delegateWithEscalation(
        {
          prompt: reworkTask.prompt,
          cwd: ctx.cwd,
          agentType: usedTier,
          briefQualityPolicy: 'off',
          timeoutMs: ctx.timing.timeoutMs,
        },
        [provider],
        {
          explicitlyPinned: true,
          taskDeadlineMs: ctx.timing.deadlineMs,
          abortSignal: ctx.stall.controller.signal,
          assignedTier: usedTier,
          // Without bus the rework's runner-shell.emit calls go nowhere — the
          // implementer turns then run silently, the reviewer keeps seeing
          // (slightly) updated code, and the chain marches through 3 rounds
          // with no visible Implementing events. Pass the same bus + ids the
          // initial-impl call uses so verbose stderr + the running headline
          // surface the rework's progress.
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
          ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          stageLabel: `Spec rework round ${round - 1}`,
        },
      ),
  });

  if (reworkCall.bothUnavailable) return null;
  const result = reworkCall.result;
  if (result.status !== 'ok') return null;
  return result;
}

function makeSpecReviewHandler(round: 1 | 2 | 3) {
  const slot = `specReviewRound${round}Verdict` as const;
  return async function specReviewRoundHandler(state: LifecycleState): Promise<void> {
    if (state[slot]) return; // idempotency
    const ctx = state.executionContext;
    if (!ctx) return; // defensive no-op
    const result = await runSpecReviewRound({ state, ctx, round });
    if (!result) return;
    state[slot] = result.verdict;
    // Tool sweep #6: accumulate concerns across rounds so the next
    // reviewer can verify the rework addressed each one. We append
    // unique concerns (skip duplicates from earlier rounds).
    if (Array.isArray(result.concerns) && result.concerns.length > 0) {
      const prior = Array.isArray(state.priorSpecConcerns) ? state.priorSpecConcerns : [];
      const seen = new Set(prior);
      const merged = [...prior];
      for (const c of result.concerns) {
        if (typeof c === 'string' && !seen.has(c)) {
          seen.add(c);
          merged.push(c);
        }
      }
      state.priorSpecConcerns = merged;
    }
    // Persist concerns into lastRunResult so the wire's per-stage
    // findingsBySeverity (driven by rr.concerns) reflects what the
    // reviewer raised — without this, findings_critical/high/medium/low
    // for spec_review stays 0 even on changes_required outcomes.
    persistSpecReviewConcerns(state, result);
    // Record per-round cost so wire task.completed sums reviewer tokens
    // and the spec_review stage entry has cumulative roundsUsed across
    // 1..3 rounds. Reviewer tier is derived from policy (round-based).
    const baseTier: AgentType = ctx.assignedTier;
    const reviewerTier = (round - 1 < 2)
      ? (baseTier === 'standard' ? 'complex' : 'standard')
      : baseTier; // round 3 swaps back to base tier per SPEC_LOOP policy
    const reviewerProvider = ctx.providers[reviewerTier];
    mergeStageStats(state, 'spec_review', {
      inputTokens: result.cost?.inputTokens ?? 0,
      outputTokens: result.cost?.outputTokens ?? 0,
      turnCount: result.cost?.turnCount ?? 0,
      toolCallCount: result.cost?.toolCallCount ?? 0,
      costUSD: result.cost?.costUSD ?? null,
      durationMs: result.cost?.durationMs ?? null,
    }, {
      tier: reviewerTier,
      model: (reviewerProvider?.config as { model?: string } | undefined)?.model ?? null,
      verdict: result.verdict,
    });
  };
}

/** Push reviewer concerns into state.lastRunResult.concerns so the wire
 *  findingsBySeverity bucket for spec_review counts them. Spec reviewer
 *  emits free-text concerns (no per-item severity), so we default to
 *  'medium' — this matches the v3.x defaulting in event-builder. */
function persistSpecReviewConcerns(state: LifecycleState, result: ReviewerCallResult): void {
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return;
  const reviewerConcerns = result.concerns;
  if (!Array.isArray(reviewerConcerns) || reviewerConcerns.length === 0) return;
  const newConcerns = reviewerConcerns.map(text => ({
    source: 'spec_review' as const,
    severity: 'medium' as const,
    message: text,
  }));
  last.concerns = [...(last.concerns ?? []), ...newConcerns];
}

function makeSpecReworkHandler(round: 1 | 2) {
  return async function specReworkHandler(state: LifecycleState): Promise<void> {
    const ctx = state.executionContext;
    if (!ctx) return;
    const newResult = await runSpecRework({ state, ctx, round: (round + 1) as 2 | 3 });
    if (!newResult) {
      // The rework's implementer call did not return an ok RunResult.
      // Don't silently fall through to the next review round — that would
      // re-review the unchanged code and produce the "3 reviews, 0 reworks"
      // pattern. Mark the chain failed so the next round's `!s.terminal`
      // gate stops the cascade and settle_spec_chain can record the
      // failure on the wire envelope.
      state.specReworkFailed = true;
      state.terminal = true;
      if (ctx.verbose && typeof ctx.verboseStream === 'function') {
        ctx.verboseStream(
          `[mmagent verbose] event=spec_rework_failed ts=${new Date().toISOString()} batch_id=${ctx.batchId ?? ''} task_index=${ctx.taskIndex ?? 0} round=${round}\n`,
        );
      }
      return;
    }
    // Tool sweep #6: union filesRead/filesWritten/toolCalls + preserve
    // stageStats. Pre-fix this branch only kept stageStats and dropped
    // file-tracker arrays — a spec-rework with 0 writes wiped the
    // implementer's recorded write, the envelope's filesWritten went
    // empty, and downstream qualityReviewStatus reported "no file
    // artifacts to review" despite the file being modified on disk.
    replaceLastRunResultPreservingTrackers(state, newResult);
    // Record rework cost in spec_rework stage stats so wire telemetry sees
    // it. round=1 → attemptIndex 1, round=2 → attemptIndex 2; rework tier
    // mirrors pickEscalation (impl=standard for attemptIndex 1; impl=complex
    // for attemptIndex 2 when baseTier=standard).
    const baseTier: AgentType = ctx.assignedTier;
    const reworkTier: AgentType = (round === 2 && baseTier === 'standard') ? 'complex' : baseTier;
    const reworkProvider = ctx.providers[reworkTier];
    mergeStageStats(state, 'spec_rework', {
      inputTokens: newResult.usage?.inputTokens ?? 0,
      outputTokens: newResult.usage?.outputTokens ?? 0,
      cachedReadTokens: newResult.usage?.cachedReadTokens ?? 0,
      cachedNonReadTokens: newResult.usage?.cachedNonReadTokens ?? 0,
      turnCount: newResult.turns ?? 0,
      toolCallCount: Array.isArray(newResult.toolCalls) ? newResult.toolCalls.length : 0,
      costUSD: newResult.cost?.costUSD ?? null,
      durationMs: newResult.durationMs ?? null,
      filesReadCount: Array.isArray(newResult.filesRead) ? newResult.filesRead.length : 0,
      filesWrittenCount: Array.isArray(newResult.filesWritten) ? newResult.filesWritten.length : 0,
    }, {
      tier: reworkTier,
      model: (reworkProvider?.config as { model?: string } | undefined)?.model ?? null,
    });
  };
}

export const specReviewRound1Handler = makeSpecReviewHandler(1);
export const specReviewRound2Handler = makeSpecReviewHandler(2);
export const specReviewRound3Handler = makeSpecReviewHandler(3);
export const specReworkRound1Handler = makeSpecReworkHandler(1);
export const specReworkRound2Handler = makeSpecReworkHandler(2);

/**
 * Settle handler (row 4.6). Reads the three round verdicts and writes
 * state.specChainPassed.
 *
 * Cascade rule:
 *   - Any 'approved' verdict in the chain ⇒ chain passed (true)
 *   - 'changes_required' through round 3 ⇒ chain failed (false)
 *   - 'error' in any round ⇒ chain failed (false), state.terminal = true
 *
 * Runs runOnTerminal so the chain-pass slot is authoritative even on
 * hard-fail paths. Idempotent: skips when state.specChainPassed is
 * already populated.
 */
export function settleSpecChainHandler(state: LifecycleState): void {
  if (typeof state.specChainPassed === 'boolean') return; // idempotency
  const v1 = state.specReviewRound1Verdict;
  const v2 = state.specReviewRound2Verdict;
  const v3 = state.specReviewRound3Verdict;

  if (v1 === undefined && v2 === undefined && v3 === undefined) return; // defensive no-op

  if (v1 === 'approved' || v2 === 'approved' || v3 === 'approved') {
    state.specChainPassed = true;
    return;
  }
  if (v1 === 'error' || v2 === 'error' || v3 === 'error') {
    state.specChainPassed = false;
    state.terminal = true;
    return;
  }
  state.specChainPassed = false;
}
