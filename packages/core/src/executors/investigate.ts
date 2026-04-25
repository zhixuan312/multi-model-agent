// packages/core/src/executors/investigate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/investigate.js';
import type { RunResult } from '../types.js';
import { runTasks } from '../run-tasks/index.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import {
  compileInvestigate,
  type ResolvedContextBlock,
} from '../intake/compilers/investigate.js';
import { parseInvestigationReport, type ParsedInvestigation } from '../reporting/parse-investigation-report.js';
import { deriveInvestigateWorkerStatus } from '../reporting/derive-investigate-status.js';
import { composeInvestigateTerminalHeadline } from '../reporting/compose-investigate-headline.js';

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
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    briefQualityPolicy: 'off' as const,
  };

  const startMs = Date.now();
  let results: RunResult[];
  let runtimeError: Error | undefined;
  try {
    results = await runTasks([taskSpec as any], config, {
      ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
      ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }),
      logger: ctx.logger,
    });
  } catch (e) {
    runtimeError = e instanceof Error ? e : new Error(String(e));
    const fallback: RunResult = {
      output: '',
      structuredReport: {
        summary: null,
        filesChanged: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
        extraSections: {},
      },
      workerError: runtimeError,
    } as unknown as RunResult;   // RunResult shape varies — cast only the assembly, not the field types.
    results = [fallback];
  }
  const wallClockMs = Date.now() - startMs;
  const result = results[0];

  // Pull lifecycle signals (set by the lifecycle in Task 13a).
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

  return {
    headline,
    results,
    batchTimings: computeTimings(wallClockMs, results),
    costSummary: computeAggregateCost(results),
    structuredReport: notApplicable('per-task structured report carried on result'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: ctx.batchId ?? randomUUID(),   // Prefer dispatch-supplied batchId; fall back only if absent.
    wallClockMs,
    parentModel: ctx.parentModel ?? config.defaults?.parentModel,
  };
}
