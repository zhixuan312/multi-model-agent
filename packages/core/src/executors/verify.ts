// packages/core/src/executors/verify.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/verify.js';
import type { TaskSpec, RunResult } from '../types.js';
import { executeReviewedLifecycle } from '../run-tasks/reviewed-lifecycle.js';
import { resolveAgent } from '../routing/resolve-agent.js';
import { expandContextBlocks } from '../context/expand-context-blocks.js';
import { buildVerifyQualityPrompt } from '../review/quality-only-prompts.js';
import { mapReviewVerdicts } from './_shared/review-verdict-mapping.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';
import { resolveReadOnlyReviewFlag } from '../config/read-only-review-flag.js';

// --- Ported from packages/mcp/src/tools/verify-work.ts ---

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}

function buildVerifyPrompt(
  work: string | undefined,
  filePaths: string[] | undefined,
  checklist: string[],
): string {
  const parts: string[] = ['Verify this work:'];
  if (work) parts.push(work);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  const checklistText = checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');
  parts.push(`Checklist:\n${checklistText}`);
  parts.push('For each checklist item, indicate pass/fail and provide evidence.');
  return parts.join('\n\n');
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function resolveDispatchMode(
  inlineContent: string | undefined,
  filePaths: string[] | undefined,
): 'single' | 'fan_out' {
  if (hasContent(inlineContent)) return 'single';
  const validPaths = (filePaths ?? []).filter(p => p.trim().length > 0);
  if (validPaths.length >= 2) return 'fan_out';
  return 'single';
}

function autoRegisterContextBlock(
  results: import('../types.js').RunResult[],
  store: import('../context/context-block-store.js').ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
}

export interface VerifyOutput extends ExecutorOutput {
  contextBlockId?: string;
}

export async function executeVerify(
  ctx: ExecutionContext,
  input: Input,
): Promise<VerifyOutput> {
  const { config, contextBlockStore } = ctx;

  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: `Every checklist item (${input.checklist.length} total) has a pass/fail verdict with supporting evidence from the code.`,
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext.cwd,
    contextBlockIds: input.contextBlockIds,
    parentModel,
  };

  function resolved() {
    return resolveAgent('complex', [], config);
  }

  function expand(task: TaskSpec) {
    return expandContextBlocks(task, contextBlockStore);
  }

  const lifecycleOptions = {
    batchId: ctx.batchId,
    recordHeartbeat: ctx.recordHeartbeat,
  };
  const diagnostics = {
    logger: ctx.logger,
  };

  const mode = resolveDispatchMode(input.work, input.filePaths);

  if (mode === 'fan_out') {
    const validPaths = input.filePaths!.filter(p => p.trim().length > 0);
    const promptTemplate = buildVerifyPrompt(undefined, undefined, input.checklist);
    const tasks: TaskSpec[] = validPaths.map(fp => ({
      ...baseTaskSpec,
      prompt: buildPerFilePrompt(fp, promptTemplate),
    } as TaskSpec));

    const startMs = Date.now();
    let results: RunResult[];
    try {
      results = await Promise.all(tasks.map((task, idx) =>
        executeReviewedLifecycle(
          expand(task),
          resolved(),
          config,
          idx,
          undefined,
          lifecycleOptions,
          diagnostics,
          ctx.recorder,
          ctx.route ?? 'verify',
          ctx.client,
          ctx.triggeringSkill,
          ctx.bus,
          buildVerifyQualityPrompt,
        ),
      ));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results = [{ output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], error: msg, errorCode: 'executor_error', retryable: false, durationMs: 0, structuredError: { code: 'executor_error' as const, message: msg, where: 'executor:verify' }, workerStatus: 'failed' as const }];
    }
    const wallClockMs = Date.now() - startMs;
    const ctxId = autoRegisterContextBlock(results, contextBlockStore);
    const batchTimings = computeTimings(wallClockMs, results);
    const costSummary = computeAggregateCost(results);

    const first = results[0];
    const flag = resolveReadOnlyReviewFlag();
    const useQualityReview = flag.isEnabledFor('verify_work');
    const verdicts = mapReviewVerdicts(first, !useQualityReview);

    return {
      headline: composeTerminalHeadline({ tool: 'verify', awaitingClarification: false, tasksTotal: tasks.length, tasksCompleted: results.length }),
      results,
      batchTimings,
      costSummary,
      structuredReport: notApplicable('no structured report emitted by this executor'),
      error: notApplicable('batch succeeded'),
      proposedInterpretation: notApplicable('batch not awaiting clarification'),
      batchId: randomUUID(),
      wallClockMs,
      parentModel,
      specReviewVerdict: verdicts.specReviewVerdict,
      qualityReviewVerdict: verdicts.qualityReviewVerdict,
      roundsUsed: verdicts.roundsUsed,
      ...(ctxId !== undefined && { contextBlockId: ctxId }),
    };
  }

  const prompt = buildVerifyPrompt(input.work, input.filePaths, input.checklist);
  const taskSpec = { ...baseTaskSpec, prompt } as TaskSpec;
  let results: RunResult[];
  const startMs = Date.now();
  try {
    const result = await executeReviewedLifecycle(
      expand(taskSpec),
      resolved(),
      config,
      0,
      undefined,
      lifecycleOptions,
      diagnostics,
      ctx.recorder,
      ctx.route ?? 'verify',
      ctx.client,
      ctx.triggeringSkill,
      ctx.bus,
      buildVerifyQualityPrompt,
    );
    results = [result];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results = [{ output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], error: msg, errorCode: 'executor_error', retryable: false, durationMs: 0, structuredError: { code: 'executor_error' as const, message: msg, where: 'executor:verify' }, workerStatus: 'failed' as const }];
  }
  const wallClockMs = Date.now() - startMs;
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);

  const first = results[0];
  const flag2 = resolveReadOnlyReviewFlag();
  const useQualityReview2 = flag2.isEnabledFor('verify_work');
  const verdicts = mapReviewVerdicts(first, !useQualityReview2);

  return {
    headline: composeTerminalHeadline({ tool: 'verify', awaitingClarification: false, tasksTotal: 1, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: randomUUID(),
    wallClockMs,
    parentModel,
    specReviewVerdict: verdicts.specReviewVerdict,
    qualityReviewVerdict: verdicts.qualityReviewVerdict,
    roundsUsed: verdicts.roundsUsed,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
