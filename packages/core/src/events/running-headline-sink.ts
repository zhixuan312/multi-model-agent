/**
 * RunningHeadlineSink — bus sink that translates per-turn runner events
 * into a rich `runningHeadlineSnapshot` so /batch/:id polling shows the
 * main agent something like:
 *
 *     [3/7] Quality review (Complex) - 3m 41s, 12 read, 0 write, 18 tool calls
 *
 * `[X/Y]` is the lifecycle stage cursor — current macro stage of the
 * total stages possible for this tool category. Y is hardcoded per route
 * (the lifecycle plan is deterministic given toolCategory + reviewPolicy);
 * X advances as runner_turn_completed events report new stageLabels.
 *
 * Listens to `runner_turn_completed` events emitted by RunnerShell. Keeps
 * a per-batch tally + latest stage + latest tier and updates the
 * registry's snapshot. Never emits to stderr (that's VerboseLogChannel's
 * job) — pure progress visibility for the polling tool.
 */
import type { BatchRegistry } from '../stores/batch-registry.js';

// Read-class tools: reads + searches. Write-class: writeFile / write_file.
// runShell / run_shell are uncategorized and counted only into total tools.
const READ_TOOLS = new Set(['readFile', 'read_file', 'grep', 'glob', 'listFiles', 'list_files']);
const WRITE_TOOLS = new Set(['writeFile', 'write_file']);

// Coarse stage ordering per tool route lives in lifecycle/stage-progression.ts
// (single source of truth, shared with async-dispatch + test fixtures).
import { stageProgress } from '../lifecycle/stage-progression.js';

interface PerTaskProgress {
  toolCounts: Record<string, number>;
  stageLabel?: string;
  tier?: string;
  /** ms since epoch when the first event for this (batch, task) arrived;
   *  used to compute per-task elapsed in the polling response. */
  startedAt: number;
}

function capitalizeTier(tier: string | undefined): string | undefined {
  if (!tier) return undefined;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export class RunningHeadlineSink {
  readonly name = 'running-headline';
  private progress = new Map<string, Map<number, PerTaskProgress>>();

  constructor(private readonly batchRegistry: BatchRegistry) {}

  emit(event: Record<string, unknown>): void {
    if (event['event'] !== 'runner_turn_completed') return;
    const batchId = typeof event['batchId'] === 'string' ? event['batchId'] : undefined;
    if (!batchId) return;

    // taskIndex defaults to 0 so older code paths that don't yet plumb it
    // still produce a single-task headline. New parallel-fan-out tasks pass
    // a real taskIndex and get separate snapshots.
    const taskIndex = typeof event['taskIndex'] === 'number' ? (event['taskIndex'] as number) : 0;

    const toolCalls = (event['toolCalls'] as Record<string, number> | undefined) ?? {};
    const stageLabel = typeof event['stageLabel'] === 'string' ? event['stageLabel'] : undefined;
    const tier = typeof event['tier'] === 'string' ? event['tier'] : undefined;

    let perBatch = this.progress.get(batchId);
    if (!perBatch) {
      perBatch = new Map();
      this.progress.set(batchId, perBatch);
    }
    const prior = perBatch.get(taskIndex);
    const nextCounts = { ...(prior?.toolCounts ?? {}) };
    for (const [name, count] of Object.entries(toolCalls)) {
      nextCounts[name] = (nextCounts[name] ?? 0) + count;
    }
    const next: PerTaskProgress = {
      toolCounts: nextCounts,
      stageLabel: stageLabel ?? prior?.stageLabel,
      tier: tier ?? prior?.tier,
      startedAt: prior?.startedAt ?? Date.now(),
    };
    perBatch.set(taskIndex, next);

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

    const stage = next.stageLabel ?? 'Running';
    const tierStr = capitalizeTier(next.tier);
    const workerClause = tierStr ? ` by ${tierStr} worker` : '';
    const progress = stageProgress(entry.tool, next.stageLabel);

    // Per-task snapshot. The batch handler prepends `[taskIdx/total] ` and
    // appends elapsed + stats. Final shape per line:
    //   [1/2] Implementing by Standard worker (1/7) - 5m 40s, 2 read, 0 write, 15 tool calls
    const prefix = `${stage}${workerClause} (${progress}) - `;
    const fallback = `${stage}${workerClause} (${progress})`;
    const statsClause = `, ${read} read, ${write} write, ${total} tool calls`;

    this.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, taskIndex, {
      prefix,
      statsClause,
      dispatchedAt: next.startedAt,
      fallback,
    });

    // Also update the legacy single-snapshot field so any consumer that
    // hasn't migrated to per-task still sees something current.
    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix,
      statsClause,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback,
    });
  }
}
