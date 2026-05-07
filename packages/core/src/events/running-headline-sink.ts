/**
 * RunningHeadlineSink — bus sink that translates per-turn runner events
 * into rich `runningHeadlineSnapshot` updates so /batch/:id polling shows
 * the model is actively working (turn count, tool-call breakdown) instead
 * of just the basic "1/1 running, Xs elapsed".
 *
 * Listens to `runner_turn_completed` events emitted by RunnerShell, keeps
 * a per-batch tally, and updates the registry's snapshot. Never emits to
 * stderr (that's VerboseLogChannel's job) — this is pure progress
 * visibility for the main agent's polling tool.
 */
import type { BatchRegistry } from '../stores/batch-registry.js';

// Read-class tools: file/dir reads + searches. writeFile is the only
// canonical mutation tool; runShell is uncategorized (could be either)
// and counted only in `tools` (total).
const READ_TOOLS = new Set(['readFile', 'grep', 'glob', 'listFiles']);
const WRITE_TOOLS = new Set(['writeFile']);

interface PerBatchProgress {
  toolCounts: Record<string, number>;
}

function capitalizeRoute(route: string): string {
  if (!route) return 'Running';
  return route.charAt(0).toUpperCase() + route.slice(1).replace(/-/g, ' ');
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

    const prior = this.progress.get(batchId) ?? { toolCounts: {} };
    const nextCounts = { ...prior.toolCounts };
    for (const [name, count] of Object.entries(toolCalls)) {
      nextCounts[name] = (nextCounts[name] ?? 0) + count;
    }
    this.progress.set(batchId, { toolCounts: nextCounts });

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

    // Single-task batches dominate today's traffic; stage label comes
    // from entry.tool (route name) so audit shows "Audit", delegate
    // shows "Delegate", etc. Multi-task batches keep their existing
    // shape via the tasksTotal/tasksStarted/tasksCompleted counters
    // — this sink only paints the single-task case.
    const tasksTotal = entry.tasksTotal ?? 1;
    const tasksStarted = entry.tasksStarted ?? 1;
    const stage = capitalizeRoute(entry.tool);
    const taskBracket = `[${tasksStarted}/${tasksTotal}]`;

    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix: `${taskBracket} ${stage}, `,
      statsClause: `, read=${read}, write=${write}, tools=${total}`,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback: `${taskBracket} ${stage}`,
    });
  }
}
