// packages/core/src/executors/investigate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/investigate.js';
import type { RunResult } from '../types.js';
import { executeReviewedLifecycle } from '../run-tasks/reviewed-lifecycle.js';
import { resolveAgent } from '../routing/resolve-agent.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import {
  compileInvestigate,
  type ResolvedContextBlock,
} from '../intake/compilers/investigate.js';
import { parseInvestigationReport, type ParsedInvestigation } from '../reporting/parse-investigation-report.js';
import { deriveInvestigateWorkerStatus } from '../reporting/derive-investigate-status.js';
import { composeInvestigateTerminalHeadline } from '../reporting/compose-investigate-headline.js';
import { mapReviewVerdicts } from './_shared/review-verdict-mapping.js';
import { resolveReadOnlyReviewFlag } from '../config/read-only-review-flag.js';

export interface InvestigateExecutorInput {
  input: Input;
  resolvedContextBlocks: ResolvedContextBlock[];
  canonicalizedFilePaths: string[];           // absolute canonical paths
  relativeFilePathsForPrompt: string[];       // path.relative(realCwd, canonical) — same order
}

export async function executeInvestigate(
  ctx: ExecutionContext,
  args: InvestigateExecutorInput,
): Promise<ExecutorOutput> {
  const { config } = ctx;
  const cwd = ctx.projectContext.cwd;

  const spec = compileInvestigate(
    args.input,
    args.resolvedContextBlocks,
    args.canonicalizedFilePaths,
    args.relativeFilePathsForPrompt,
    cwd,
  );

  const taskSpec = {
    ...spec,
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
  };

  const resolved = resolveAgent('complex', [], config);

  const startMs = Date.now();
  let result: RunResult;
  let runtimeError: Error | undefined;
  try {
    result = await executeReviewedLifecycle(
      taskSpec as any,
      resolved,
      config,
      0,
      undefined,
      {
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
        ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }),
      },
      { logger: ctx.logger },
      ctx.recorder,
      ctx.route ?? 'investigate',
      ctx.client,
      ctx.triggeringSkill,
      ctx.bus,
    );
  } catch (e) {
    runtimeError = e instanceof Error ? e : new Error(String(e));
    const msg = runtimeError.message;
    const fallback: RunResult = {
      output: '',
      status: 'error' as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      error: msg,
      errorCode: 'executor_error',
      retryable: false,
      durationMs: 0,
      structuredReport: {
        summary: null,
        filesChanged: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
        extraSections: {},
      },
      workerError: runtimeError,
      structuredError: {
        code: 'executor_error' as const,
        message: msg,
        where: 'executor:investigate',
      },
      workerStatus: 'failed' as const,
    } as unknown as RunResult;
    result = fallback;
  }
  const wallClockMs = Date.now() - startMs;

  // Pull lifecycle signals (set by executeReviewedLifecycle).
  const capExhausted = (result as any)?.capExhausted as 'turn' | 'cost' | 'wall_clock' | undefined;
  const workerError = runtimeError ?? ((result as any)?.workerError as Error | undefined);
  const lifecycleClarificationRequested = Boolean((result as any)?.lifecycleClarificationRequested);

  // Parse worker output.
  const parseResult = parseInvestigationReport(result?.output ?? '');

  // needs_context combines lifecycle signal + parser flag.
  const parserNeedsContext = parseResult.kind === 'structured_report'
    && parseResult.investigation.needsCallerClarification;
  const needsContext = lifecycleClarificationRequested || parserNeedsContext;

  const derived = deriveInvestigateWorkerStatus({
    needsContext,
    workerError,
    capExhausted,
    parseResult,
  });

  // Attach typed investigation field only when we have a structured report.
  let investigation: ParsedInvestigation | undefined;
  if (parseResult.kind === 'structured_report') {
    investigation = parseResult.investigation;
    if (result?.structuredReport) {
      (result.structuredReport as any).investigation = investigation;
    }
  }

  // Override per-task workerStatus authoritatively.
  if (result) {
    (result as any).workerStatus = derived.workerStatus;
    if (derived.incompleteReason !== undefined) {
      (result as any).incompleteReason = derived.incompleteReason;
    }
  }

  const headline = composeInvestigateTerminalHeadline({
    question: args.input.question,
    workerStatus: derived.workerStatus,
    citationCount: investigation?.citations.length ?? 0,
    confidenceLevel: investigation?.confidence?.level ?? null,
    unresolvedCount: result?.structuredReport?.unresolved?.length ?? 0,
    ...(derived.incompleteReason !== undefined && { incompleteReason: derived.incompleteReason }),
  });

  const flag = resolveReadOnlyReviewFlag();
  const useQualityReview = flag.isEnabledFor('investigate_codebase');
  const reviewVerdicts = mapReviewVerdicts(result, !useQualityReview);

  return {
    headline,
    results: [result],
    batchTimings: computeTimings(wallClockMs, [result]),
    costSummary: computeAggregateCost([result]),
    structuredReport: notApplicable('per-task structured report carried on result'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: ctx.batchId ?? randomUUID(),
    wallClockMs,
    parentModel: ctx.parentModel ?? config.defaults?.parentModel,
    specReviewVerdict: reviewVerdicts.specReviewVerdict,
    qualityReviewVerdict: reviewVerdicts.qualityReviewVerdict,
    roundsUsed: reviewVerdicts.roundsUsed,
  };
}
