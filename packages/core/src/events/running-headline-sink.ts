/**
 * RunningHeadlineSink — bus sink that translates per-turn runner events
 * into a rich `runningHeadlineSnapshot` so /batch/:id polling shows the
 * main agent something like:
 *
 *     [1/1] Implementing (Complex) - 3m 41s, 1 read, 2 write, 3 tool calls
 *
 * Listens to `runner_turn_completed` events emitted by RunnerShell, keeps
 * a per-batch tally + latest tier + latest stage, and updates the
 * registry's snapshot. Never emits to stderr (that's VerboseLogChannel's
 * job) — pure progress visibility for the polling tool.
 */
import type { BatchRegistry } from '../stores/batch-registry.js';

// Read-class tools: reads + searches. Write-class: writeFile only.
// Anything else (runShell, custom toolset items) counts only into the
// total `tools` bucket so the line never under-reports activity.
const READ_TOOLS = new Set(['readFile', 'grep', 'glob', 'listFiles']);
const WRITE_TOOLS = new Set(['writeFile']);

interface PerBatchProgress {
  toolCounts: Record<string, number>;
  stageLabel?: string;
  tier?: string;
}

function capitalizeTier(tier: string | undefined): string | undefined {
  if (!tier) return undefined;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export class RunningHeadlineSink {
  readonly name = 'running-headline';
  private progress = new Map<string, PerBatchProgress>();

  constructor(private readonly batchRegistry: BatchRegistry) {}

  emit(event: Record<string, unknown>): void {
    if (event['event'] !== 'runner_turn_completed') return;
    const batchId = typeof event['batchId'] === 'string' ? event['batchId'] : undefined;
    if (!batchId) return;

    const toolCalls = (event['toolCalls'] as Record<string, number> | undefined) ?? {};
    const stageLabel = typeof event['stageLabel'] === 'string' ? event['stageLabel'] : undefined;
    const tier = typeof event['tier'] === 'string' ? event['tier'] : undefined;

    const prior = this.progress.get(batchId) ?? { toolCounts: {} };
    const nextCounts = { ...prior.toolCounts };
    for (const [name, count] of Object.entries(toolCalls)) {
      nextCounts[name] = (nextCounts[name] ?? 0) + count;
    }
    const next: PerBatchProgress = {
      toolCounts: nextCounts,
      stageLabel: stageLabel ?? prior.stageLabel,
      tier: tier ?? prior.tier,
    };
    this.progress.set(batchId, next);

    const entry = this.batchRegistry.get(batchId);
    if (!entry) return;

    let read = 0;
    let write = 0;
    let total = 0;
    for (const [name, count] of Object.entries(nextCounts)) {
      total += count;
      if (READ_TOOLS.has(name)) read += count;
      else if (WRITE_TOOLS.has(name)) write += count;
    }

    const tasksTotal = entry.tasksTotal ?? 1;
    const tasksStarted = entry.tasksStarted ?? 1;
    const taskBracket = `[${tasksStarted}/${tasksTotal}]`;
    const stage = next.stageLabel ?? 'Running';
    const tierStr = capitalizeTier(next.tier);
    const tierClause = tierStr ? ` (${tierStr})` : '';

    // Final shape: `[1/1] Implementing (Complex) - 3m 41s, 1 read, 2 write, 3 tool calls`
    // The batch handler concatenates `prefix` + `formatElapsed(elapsedMs)` +
    // `statsClause`; `prefix` ends with ` - ` so the elapsed lands cleanly.
    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix: `${taskBracket} ${stage}${tierClause} - `,
      statsClause: `, ${read} read, ${write} write, ${total} tool calls`,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback: `${taskBracket} ${stage}${tierClause}`,
    });
  }
}
