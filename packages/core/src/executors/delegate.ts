// packages/core/src/executors/delegate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/delegate.js';
import type { TaskSpec, RunResult } from '../types.js';
import { runTasks } from '../run-tasks/index.js';
import type { RunTasksOptions } from '../run-tasks/index.js';
import { compileDelegateTasks } from '../intake/compilers/delegate.js';
import type { DelegateTaskInput } from '../intake/compilers/delegate.js';
import { runIntakePipeline } from '../intake/pipeline.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import type { ClarificationEntry } from '../intake/types.js';
import { notApplicable, isNotApplicable, type NotApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';

/**
 * Synthesize a human-readable proposedInterpretation from clarification entries.
 * Extracted so edge cases can be tested independently.
 */
export function synthesizeProposedInterpretation(
  clarifications: ClarificationEntry[],
): string {
  const firstQuestion = clarifications[0]?.questions?.[0];
  if (firstQuestion && firstQuestion.trim().length > 0) {
    return `Interpreting your request as the answer to: ${firstQuestion}`;
  }
  // Fallback: use the first clarification's reason, or a generic phrase
  const fallbackReason = clarifications[0]?.reason?.trim();
  if (fallbackReason) {
    return `Interpreting your request based on: ${fallbackReason}`;
  }
  return 'Interpreting your request based on the proposed draft';
}

/**
 * Invariant: when clarifications are pending, proposedInterpretation must be
 * a real string — never notApplicable. Extracted so the invariant itself can
 * be tested directly (forcing the bug path).
 */
export function assertInterpretationAvailable(
  awaitingClarification: boolean,
  proposedInterpretation: string | NotApplicable,
): void {
  if (awaitingClarification && isNotApplicable(proposedInterpretation)) {
    throw new Error(
      'proposedInterpretation invariant violation: clarifications present but interpretation is not_applicable',
    );
  }
}

export interface DelegateOptions {
  /**
   * Injects harness-level defaults (tools, timeoutMs, cwd, etc.) into each TaskSpec.
   * Provided by the MCP layer; a future REST layer will supply its own implementation.
   */
  injectDefaults: (tasks: TaskSpec[]) => TaskSpec[];
  /**
   * Optional override for `runTasks` — used in tests to inject a mock implementation.
   */
  runTasksOverride?: typeof runTasks;
  /**
   * Optional progress callback passed through to runTasks.
   */
  onProgress?: RunTasksOptions['onProgress'];
}

export interface DelegateOutput extends ExecutorOutput {
  clarifications?: ClarificationEntry[];
  tasks: TaskSpec[];
  wallClockMs: number;
}

export async function executeDelegate(
  ctx: ExecutionContext,
  input: Input,
  options: DelegateOptions,
): Promise<DelegateOutput> {
  const { config, projectContext, contextBlockStore } = ctx;
  const { injectDefaults, onProgress } = options;
  const runTasksImpl = options.runTasksOverride ?? runTasks;
  const { batchCache, clarifications: clarificationStore } = projectContext;

  // Intake pipeline: compile → infer → classify → resolve
  const requestId = randomUUID();
  const drafts = compileDelegateTasks(
    input.tasks as DelegateTaskInput[],
    requestId,
  );
  const intakeResult = runIntakePipeline(drafts, config, contextBlockStore, ctx.batchId);

  if (ctx.batchId === undefined) {
    throw new Error('executeDelegate requires ctx.batchId');
  }
  let results: RunResult[] = [];
  const readySpecs = intakeResult.ready.map(r => r.task);
  // Inject harness-level defaults (cwd, timeoutMs, maxCostUSD, etc.) so the
  // response envelope's `tasks` field reflects what was actually executed —
  // not the pre-inject intake output. Otherwise goldens that pin cwd/timeout
  // mismatch the response.
  const resolvedReadySpecs = readySpecs.length > 0 ? injectDefaults(readySpecs) : readySpecs;
  const batchId = batchCache.remember(ctx.batchId, resolvedReadySpecs.length > 0 ? resolvedReadySpecs : (input.tasks as TaskSpec[]));

  const batchStartMs = Date.now();
  let batchAborted = false;
  try {
    if (resolvedReadySpecs.length > 0) {
      results = await runTasksImpl(resolvedReadySpecs, config, {
        onProgress,
        runtime: { contextBlockStore },
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
        ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }),
        logger: ctx.logger,
        ...(ctx.recorder !== undefined && { recorder: ctx.recorder }),
        ...(ctx.route !== undefined && { route: ctx.route }),
        ...(ctx.client !== undefined && { client: ctx.client }),
        ...(ctx.triggeringSkill !== undefined && { triggeringSkill: ctx.triggeringSkill }),
      });
      intakeResult.intakeProgress.executedDrafts = results.length;
    }
  } catch (err) {
    batchAborted = true;
    const message = err instanceof Error ? err.message : String(err);
    const fallback: RunResult = {
      output: '',
      status: 'error' as RunResult['status'],
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      parsedFindings: null,
      error: message,
      errorCode: 'executor_error',
      retryable: false,
      durationMs: 0,
      structuredError: { code: 'executor_error' as const, message, where: 'executor:delegate' },
      workerStatus: 'failed' as const,
    };
    results = readySpecs.length > 0 ? readySpecs.map(() => ({ ...fallback })) : [fallback];
  } finally {
    if (batchAborted) {
      try { batchCache.abort(batchId); } catch { /* already terminal */ }
    } else {
      try { batchCache.complete(batchId, results); } catch { /* already terminal */ }
    }
  }
  const wallClockMs = Date.now() - batchStartMs;

  // Create clarification set if needed
  let clarificationId: string | undefined;
  if (intakeResult.clarifications.length > 0) {
    const storedDrafts = intakeResult.clarifications.map(c => ({
      draft: drafts.find(d => d.draftId === c.draftId)!,
      taskIndex: c.taskIndex,
      roundCount: 0,
    }));
    clarificationId = clarificationStore.create(storedDrafts, batchId);
  }

  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const mainModel = ctx.mainModel ?? config.defaults?.mainModel ?? undefined;

  const awaitingClarification = intakeResult.clarifications.length > 0;
  const tasksTotal = readySpecs.length;
  const tasksCompleted = results.length;

  const proposedInterpretation: string | NotApplicable = awaitingClarification
    ? synthesizeProposedInterpretation(intakeResult.clarifications)
    : notApplicable('batch not awaiting clarification');

  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    assertInterpretationAvailable(awaitingClarification, proposedInterpretation);
  }

  return {
    headline: composeTerminalHeadline({ tool: 'delegate', awaitingClarification, tasksTotal, tasksCompleted }),
    results: awaitingClarification ? notApplicable('awaiting clarification') : results,
    batchTimings: awaitingClarification ? notApplicable('awaiting clarification') : batchTimings,
    costSummary: awaitingClarification ? notApplicable('awaiting clarification') : costSummary,
    structuredReport: awaitingClarification
      ? notApplicable('awaiting clarification')
      : notApplicable('no structured report emitted by this executor'),
    error: notApplicable(awaitingClarification ? 'awaiting clarification' : 'batch succeeded'),
    proposedInterpretation,
    batchId,
    tasks: resolvedReadySpecs,
    wallClockMs,
    mainModel,
    ...(clarificationId !== undefined && { clarificationId }),
    ...(intakeResult.clarifications.length > 0 && { clarifications: intakeResult.clarifications }),
  };
}
