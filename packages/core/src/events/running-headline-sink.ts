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

// Coarse stage ordering per tool route. The actual lifecycle plan has more
// fine-grained rows (3 spec-review rounds, 3 quality-review rounds, rework
// loops, etc.) — these collapse into "Spec review" / "Quality review" /
// etc. so the main agent's bracket shows real progress, not row noise.
//
// Stages without a runner-shell call (Verifying / Committing) are listed
// here for accurate `Y` denominators even though the sink can't directly
// observe them; the bracket advances only on stages with runner activity.
const STAGE_ORDER_BY_ROUTE: Record<string, readonly string[]> = {
  delegate:       ['Implementing', 'Spec review', 'Quality review', 'Diff review', 'Verifying', 'Committing', 'Finalizing'],
  'execute-plan': ['Implementing', 'Spec review', 'Quality review', 'Diff review', 'Verifying', 'Committing', 'Finalizing'],
  retry:          ['Implementing', 'Spec review', 'Quality review', 'Diff review', 'Verifying', 'Committing', 'Finalizing'],
  audit:          ['Implementing', 'Annotating', 'Finalizing'],
  review:         ['Implementing', 'Annotating', 'Finalizing'],
  verify:         ['Implementing', 'Annotating', 'Finalizing'],
  debug:          ['Implementing', 'Annotating', 'Finalizing'],
  investigate:    ['Implementing', 'Annotating', 'Finalizing'],
  explore:        ['Implementing', 'Finalizing'],
  'register-context-block': ['Registering', 'Finalizing'],
};

interface PerBatchProgress {
  toolCounts: Record<string, number>;
  stageLabel?: string;
  tier?: string;
}

function capitalizeTier(tier: string | undefined): string | undefined {
  if (!tier) return undefined;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function stageBracket(route: string, stageLabel: string | undefined): string {
  const order = STAGE_ORDER_BY_ROUTE[route];
  if (!order || order.length === 0) return '[1/1]';
  const total = order.length;
  if (!stageLabel) return `[1/${total}]`;
  const idx = order.indexOf(stageLabel);
  // Unknown stage labels still surface — fall through to first slot.
  const oneBased = idx === -1 ? 1 : idx + 1;
  return `[${oneBased}/${total}]`;
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

    const stage = next.stageLabel ?? 'Running';
    const tierStr = capitalizeTier(next.tier);
    const tierClause = tierStr ? ` (${tierStr})` : '';
    const bracket = stageBracket(entry.tool, next.stageLabel);

    // Final shape: `[3/7] Quality review (Complex) - 3m 41s, 12 read, 0 write, 18 tool calls`
    // The batch handler concatenates `prefix` + `formatElapsed(elapsedMs)` +
    // `statsClause`; `prefix` ends with ` - ` so the elapsed lands cleanly.
    this.batchRegistry.updateRunningHeadlineSnapshot(batchId, {
      prefix: `${bracket} ${stage}${tierClause} - `,
      statsClause: `, ${read} read, ${write} write, ${total} tool calls`,
      dispatchedAt: entry.runningHeadlineSnapshot.dispatchedAt,
      fallback: `${bracket} ${stage}${tierClause}`,
    });
  }
}
