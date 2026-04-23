// packages/core/src/executors/verify.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/verify.js';
import type { TaskSpec } from '../types.js';
import { runTasks } from '../run-tasks.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';

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

  const parentModel = process.env.PARENT_MODEL_NAME || config.defaults?.parentModel || undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: 'standard',
    reviewPolicy: 'spec_only',
    briefQualityPolicy: 'off',
    done: `Every checklist item (${input.checklist.length} total) has a pass/fail verdict with supporting evidence from the code.`,
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: process.cwd(),
    contextBlockIds: input.contextBlockIds,
    parentModel,
  };
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  const mode = resolveDispatchMode(input.work, input.filePaths);

  if (mode === 'fan_out') {
    const validPaths = input.filePaths!.filter(p => p.trim().length > 0);
    const promptTemplate = buildVerifyPrompt(undefined, undefined, input.checklist);
    const tasks: TaskSpec[] = validPaths.map(fp => ({
      ...baseTaskSpec,
      prompt: buildPerFilePrompt(fp, promptTemplate),
    } as TaskSpec));

    const startMs = Date.now();
    const results = await runTasks(tasks, config, { runtime });
    const wallClockMs = Date.now() - startMs;
    const ctxId = autoRegisterContextBlock(results, contextBlockStore);
    const batchTimings = computeTimings(wallClockMs, results);
    const costSummary = computeAggregateCost(results);

    return {
      results,
      headline: '',
      batchTimings,
      costSummary,
      batchId: randomUUID(),
      wallClockMs,
      parentModel,
      ...(ctxId !== undefined && { contextBlockId: ctxId }),
    };
  }

  const prompt = buildVerifyPrompt(input.work, input.filePaths, input.checklist);
  const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config, { runtime });
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(0, results);
  const costSummary = computeAggregateCost(results);

  return {
    results,
    headline: '',
    batchTimings,
    costSummary,
    batchId: randomUUID(),
    wallClockMs: 0,
    parentModel,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
