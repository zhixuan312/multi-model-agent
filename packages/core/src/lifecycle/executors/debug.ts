// packages/core/src/executors/debug.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../../tools/debug/schema.js';
import type { TaskSpec, RunResult } from '../../types.js';
import { runTasks } from '../dispatch-task.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../../reporting/compose-terminal-headline.js';
import { buildDebugQualityPrompt } from '../../review/quality-only-prompts.js';
import { mapReviewVerdicts } from '../../review/review-verdict-mapping.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

// --- Ported from packages/mcp/src/tools/debug-task.ts ---

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function autoRegisterContextBlock(
  results: import('../../types.js').RunResult[],
  store: import('../../stores/context-block-tool.js').ContextBlockStore | undefined,
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
  parts.push(
    'Use hypothesis-driven debugging. Use this EXACT per-finding format so the deterministic extractor can recover findings if the structured reviewer pass fails:',
    '',
    '## Finding 1: <one-line title>',
    '- Severity: critical | high | medium | low',
    '- Hypothesis: the candidate cause',
    '- Evidence: trace, log, or code path with file:line',
    '- Fix: proposed change',
    '',
    '## Finding 2: <one-line title>',
    '- Severity: ...',
    '- ...',
    '',
    'Rules:',
    '- Each finding heading MUST start with "## Finding N: " (h2, "Finding ", number, colon, title) — number sequentially from 1.',
    '- Severity / Hypothesis / Evidence / Fix bullets are on their own lines with the labels exactly as shown.',
    '- Do NOT emit JSON. Both the structured reviewer and the deterministic fallback extract from this same format — the format is the single source of truth.',
  );
  const prompt = parts.join('\n\n');

  const mainModel = ctx.mainModel ?? config.defaults?.mainModel ?? undefined;

  const taskSpec: Partial<TaskSpec> = {
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: 'Identify the root cause with evidence (file, line, mechanism). Propose a fix. Verify the fix resolves the problem.',
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext.cwd,
    contextBlockIds: input.contextBlockIds,
    mainModel,
    autoCommit: false,
  };
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  const startMs = Date.now();
  let results: RunResult[];
  try {
    results = await runTasks([{ ...taskSpec, prompt } as TaskSpec], config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }), logger: ctx.logger, ...(ctx.recorder !== undefined && { recorder: ctx.recorder }), ...(ctx.route !== undefined && { route: ctx.route }), ...(ctx.client !== undefined && { client: ctx.client }), ...(ctx.triggeringSkill !== undefined && { triggeringSkill: ctx.triggeringSkill }), qualityReviewPromptBuilder: buildDebugQualityPrompt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results = [{ output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], parsedFindings: null, error: msg, errorCode: 'runner_crash', retryable: false, durationMs: 0, structuredError: { code: 'runner_crash' as const, message: msg, where: 'executor:debug' }, workerStatus: 'failed' as const }];
  }
  const wallClockMs = Date.now() - startMs;
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const verdicts = mapReviewVerdicts(results[0], false);

  return {
    headline: composeTerminalHeadline({ tool: 'debug', tasksTotal: 1, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    batchId: randomUUID(),
    wallClockMs,
    mainModel,
    specReviewVerdict: verdicts.specReviewVerdict,
    qualityReviewVerdict: verdicts.qualityReviewVerdict,
    roundsUsed: verdicts.roundsUsed,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
