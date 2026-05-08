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

// Tool-name sets are centralized in providers/tool-name-sets.ts —
// historically the sink had WRITE_TOOLS = {writeFile, write_file}
// while runner-shell had {..., editFile, edit_file}. Drift caused the
// polling headline to report "0 write" even though `edit_file` modified
// files. Single source of truth eliminates the risk (Gap 14, 4.0.3+).
import { READ_TOOL_NAMES as READ_TOOLS, WRITE_TOOL_NAMES as WRITE_TOOLS } from '../providers/tool-name-sets.js';

// Coarse stage ordering per tool route lives in lifecycle/stage-progression.ts
// (single source of truth, shared with async-dispatch + test fixtures).
import { stageProgress } from '../lifecycle/stage-progression.js';

interface PerTaskProgress {
  toolCounts: Record<string, number>;
  /** Gap 11 (4.0.3+): cumulative count of run_shell calls that wrote to
   *  the filesystem (sed -i, cat >, tee, etc.). Tracked separately from
   *  WRITE_TOOLS because run_shell isn't categorized by tool name; the
   *  runner-shell emits this in `shellWrites` on runner_turn_completed. */
  shellWrites: number;
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
    const shellWritesDelta = typeof event['shellWrites'] === 'number' ? (event['shellWrites'] as number) : 0;
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
      shellWrites: (prior?.shellWrites ?? 0) + shellWritesDelta,
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
    // Gap 11 (4.0.3+): include run_shell calls that wrote to the FS so
    // the headline shows real activity instead of "0 write" while
    // sed -i / cat > / tee actively produces artifacts.
    write += next.shellWrites;

    const stage = next.stageLabel ?? 'Running';
    const tierStr = capitalizeTier(next.tier);
    const workerClause = tierStr ? ` by ${tierStr} worker` : '';
    const progress = stageProgress(entry.tool, next.stageLabel);
    const [progDoneStr, progTotalStr] = progress.split('/');
    const stageDone = Number(progDoneStr);
    const stageTotal = Number(progTotalStr);

    // Per-task snapshot. Carries both the legacy pre-rendered prefix/statsClause
    // (still consumed when no aggregation is possible) AND the structured fields
    // the batch handler uses to compose ONE aggregated line for batches.
    // Final single-task shape:
    //   [1/1] Implementing by Standard worker (1/7) - 5m 40s, 2 read, 0 write, 15 tool calls
    const prefix = `${stage}${workerClause} (${progress}) - `;
    const fallback = `${stage}${workerClause} (${progress})`;
    const statsClause = `, ${read} read, ${write} write, ${total} tool calls`;

    this.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, taskIndex, {
      prefix,
      statsClause,
      dispatchedAt: next.startedAt,
      fallback,
      stageLabel: stage,
      tier: tierStr,
      stageDone: Number.isFinite(stageDone) ? stageDone : undefined,
      stageTotal: Number.isFinite(stageTotal) ? stageTotal : undefined,
      toolReads: read,
      toolWrites: write,
      toolTotal: total,
    });

    // Also update the legacy single-snapshot field so any consumer that
    // hasn't migrated to per-task still sees something current.
    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix,
      statsClause,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback,
      stageLabel: stage,
      tier: tierStr,
      stageDone: Number.isFinite(stageDone) ? stageDone : undefined,
      stageTotal: Number.isFinite(stageTotal) ? stageTotal : undefined,
      toolReads: read,
      toolWrites: write,
      toolTotal: total,
    });
  }
}
