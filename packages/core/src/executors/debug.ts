// packages/core/src/executors/debug.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/debug.js';
import type { TaskSpec, RunResult } from '../types.js';
import { runTasks } from '../run-tasks/index.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';
import { buildDebugQualityPrompt } from '../review/quality-only-prompts.js';
import { mapReviewVerdicts } from './_shared/review-verdict-mapping.js';
import { resolveReadOnlyReviewFlag } from '../config/read-only-review-flag.js';

// --- Ported from packages/mcp/src/tools/debug-task.ts ---

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
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

export interface DebugOutput extends ExecutorOutput {
  contextBlockId?: string;
}

export async function executeDebug(
  ctx: ExecutionContext,
  input: Input,
): Promise<DebugOutput> {
  const { config, contextBlockStore } = ctx;

  const parts: string[] = [`Debug this problem:\n\n${input.problem}`];
  if (input.context) parts.push(`Context: ${input.context}`);
  if (input.hypothesis) parts.push(`Initial hypothesis: ${input.hypothesis}`);
  const fileSection = buildFilePathsPrompt(input.filePaths);
  if (fileSection) parts.push(fileSection);
  parts.push('Use hypothesis-driven debugging: identify root cause, propose fix, verify.');
  const prompt = parts.join('\n\n');

  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const taskSpec: Partial<TaskSpec> = {
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: 'Identify the root cause with evidence (file, line, mechanism). Propose a fix. Verify the fix resolves the problem.',
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext.cwd,
    contextBlockIds: input.contextBlockIds,
    parentModel,
    autoCommit: false,
  };
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  let results: RunResult[];
  try {
    results = await runTasks([{ ...taskSpec, prompt } as TaskSpec], config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }), logger: ctx.logger, ...(ctx.recorder !== undefined && { recorder: ctx.recorder }), ...(ctx.route !== undefined && { route: ctx.route }), ...(ctx.client !== undefined && { client: ctx.client }), ...(ctx.triggeringSkill !== undefined && { triggeringSkill: ctx.triggeringSkill }), qualityReviewPromptBuilder: buildDebugQualityPrompt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results = [{ output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], error: msg, errorCode: 'executor_error', retryable: false, durationMs: 0, structuredError: { code: 'executor_error' as const, message: msg, where: 'executor:debug' }, workerStatus: 'failed' as const }];
  }
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(0, results);
  const costSummary = computeAggregateCost(results);
  const flag = resolveReadOnlyReviewFlag();
  const useQualityReview = flag.isEnabledFor('debug_task');
  const verdicts = mapReviewVerdicts(results[0], !useQualityReview);

  return {
    headline: composeTerminalHeadline({ tool: 'debug', awaitingClarification: false, tasksTotal: 1, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: randomUUID(),
    wallClockMs: 0,
    parentModel,
    specReviewVerdict: verdicts.specReviewVerdict,
    qualityReviewVerdict: verdicts.qualityReviewVerdict,
    roundsUsed: verdicts.roundsUsed,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
