// Read-only-route Annotating handler (4.3.0+ pipeline redesign).
//
// Mirrors the artifact-producing annotate_completion stage but consumes
// the per-criterion `workerOutputs` produced by dispatchParallelCriteria
// in run_initial_impl, and emits AnnotatorCallResult (annotated findings
// per criterion). Wired for the 5 read-only routes: audit, review,
// verify, debug, investigate.
//
// stageLabel='Annotating' so the user-facing headline shows the same
// stage label as the artifact-producing Annotating stage.
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import type { AnnotatorRoute } from '../../review/annotator-prompt-builder.js';
import { makeRunnerShell } from '../../providers/make-runner-shell.js';
import { mergeStageStats } from '../merge-stage-stats.js';

/** Routes that go through the parallel-criteria + annotate pipeline. */
const ANNOTATABLE_READONLY_ROUTES = new Set<string>([
  'audit', 'review', 'verify', 'debug', 'investigate',
]);

function isAnnotatorRoute(route: string | undefined): route is AnnotatorRoute {
  return route !== undefined && ANNOTATABLE_READONLY_ROUTES.has(route);
}

export async function annotateCriteriaHandler(state: LifecycleState): Promise<void> {
  if (state.terminal) return;
  // Idempotency
  if ((state.lastRunResult as { annotatedFindings?: unknown[] } | undefined)?.annotatedFindings !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as (RunResult & {
    workerOutputs?: Array<{ criterionId: string; criterionTitle: string; narrative: string }>;
  }) | undefined;
  if (!ctx || !task || !last) return;

  const route = state.route ?? ctx.route;
  if (!isAnnotatorRoute(route)) return;
  const annotatorEngine = ctx.annotatorEngine;
  if (!annotatorEngine) return; // no-op when annotator not configured

  const outputs = last.workerOutputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return;

  const tier: AgentType = ctx.assignedTier;
  const provider = ctx.providers[tier] as Provider | undefined;
  if (!provider) return;

  const shell = makeRunnerShell(provider);

  let result;
  try {
    result = await annotatorEngine.annotate(shell, {
      workerOutputs: outputs.map(o => ({ criterion: o.criterionTitle, narrative: o.narrative })),
      brief: task.prompt ?? '',
      cwd: ctx.cwd,
      route,
      abortSignal: ctx.stall.controller.signal,
      deadlineMs: ctx.timing.deadlineMs,
      ...(ctx.bus && { bus: ctx.bus }),
      ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
      ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
      tier,
      stageLabel: 'Annotating',
    });
  } catch {
    // Annotator failure shouldn't terminate the lifecycle; surface raw
    // workerOutputs and let compose_response build the envelope.
    return;
  }

  // Attach annotated findings + verdict + raw assistant text to
  // lastRunResult so compose_response and the per-tool report parser
  // can pick them up.
  (last as { annotatedFindings?: unknown[] }).annotatedFindings = result.annotatedFindings;
  (last as { qualityReviewVerdict?: string }).qualityReviewVerdict = result.verdict;
  if (typeof result.finalAssistantText === 'string' && result.finalAssistantText.trim().length > 0) {
    last.output = result.finalAssistantText;
  }
  const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedNonReadTokens?: number } }).usage;
  mergeStageStats(state, 'annotating', {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedReadTokens: usage?.cachedReadTokens ?? 0,
    cachedNonReadTokens: usage?.cachedNonReadTokens ?? 0,
    turnCount: (result as { turns?: number }).turns ?? 1,
    toolCallCount: 0,
    costUSD: (result as { costUSD?: number | null }).costUSD ?? null,
    durationMs: (result as { durationMs?: number }).durationMs ?? null,
  }, {
    tier,
    model: (provider?.config as { model?: string } | undefined)?.model ?? null,
  });
}
