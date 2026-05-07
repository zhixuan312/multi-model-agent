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

interface PerBatchProgress {
  turnIndex: number;
  toolCounts: Record<string, number>;
}

export class RunningHeadlineSink {
  readonly name = 'running-headline';
  private progress = new Map<string, PerBatchProgress>();

  constructor(private readonly batchRegistry: BatchRegistry) {}

  emit(event: Record<string, unknown>): void {
    if (event['event'] !== 'runner_turn_completed') return;
    const batchId = typeof event['batchId'] === 'string' ? event['batchId'] : undefined;
    if (!batchId) return;

    const turnIndex = typeof event['turnIndex'] === 'number' ? event['turnIndex'] : 0;
    const toolCalls = (event['toolCalls'] as Record<string, number> | undefined) ?? {};

    const prior = this.progress.get(batchId) ?? { turnIndex: -1, toolCounts: {} };
    const nextCounts = { ...prior.toolCounts };
    for (const [name, count] of Object.entries(toolCalls)) {
      nextCounts[name] = (nextCounts[name] ?? 0) + count;
    }
    const next: PerBatchProgress = { turnIndex, toolCounts: nextCounts };
    this.progress.set(batchId, next);

    const entry = this.batchRegistry.get(batchId);
    if (!entry) return;

    // Build a compact tool-count clause: "readFile=12 grep=5". Sorted by
    // count desc so the busiest tools appear first; capped at the top
    // four so the line stays readable at typical 120-col widths.
    const toolEntries = Object.entries(nextCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const toolClause = toolEntries.length > 0
      ? `, ${toolEntries.map(([k, v]) => `${k}=${v}`).join(' ')}`
      : '';

    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix: `1/1 running, `,
      statsClause: `, turn ${turnIndex + 1}${toolClause}`,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback: `1/1 running, turn ${turnIndex + 1}`,
    });
  }
}
