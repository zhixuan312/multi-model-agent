/**
 * The one place a live task describes itself, shared by both wires.
 *
 * A task handle used to be an opaque UUID: `mma_run` returned `{ taskId }`, and every
 * poll answered with a phase name (`implementing` | `reviewing`) that reads the same for
 * a spec, a review and an investigation. The type was known from the moment of admission
 * — `TaskEntry.tool`, set by `TaskRegistry.register` — and was read on the way out ONLY
 * to decide whether to attach `totalTasks`. Identity was in hand and thrown away.
 *
 * `runningSnapshot` previously existed as two hand-maintained copies (mcp-adapter.ts and
 * http/handlers/unified-task.ts). They drifted — MCP omitted `phaseElapsedMs` for a while,
 * so "one contract, two wires" was untrue in practice. Both wires now call these
 * functions, which is why identity cannot drift back apart.
 */

import type { TaskEntry } from '@zhixuan92/multi-model-agent-core';

/**
 * Who this task is, independent of how far along it is. Carried on the admission
 * response AND on every poll: an agent scanning back through a transcript reads the
 * handle where it was returned, not where the task was submitted.
 *
 * `cwd` earns its place on a multi-repo workspace, where four sibling checkouts run the
 * same task types and the path is the only thing distinguishing them.
 */
interface TaskIdentity {
  taskId: string;
  type: string;
  /** Present only for `audit`, matching the terminal envelope's `task.subtype`. */
  subtype?: string;
  cwd: string;
}

export function taskIdentity(entry: TaskEntry): TaskIdentity {
  return {
    taskId: entry.taskId,
    type: entry.tool,
    ...(entry.subtype !== null ? { subtype: entry.subtype } : {}),
    cwd: entry.cwd,
  };
}

/**
 * The running-progress payload both wires return for a non-terminal task: identity
 * first, then how far along it is.
 *
 * Optional fields stay ABSENT rather than null when they have no value — the execution
 * monitor renders a label only when its field is present, and a `null` would print an
 * empty row that reads as a failure to load.
 */
/**
 * How many buckets a reader gets. Matches the strip the execution monitor draws; a caller that
 * wants finer resolution would need the raw samples, which stay in the registry.
 */
const ACTIVITY_BUCKETS = 34;

/**
 * Bucket a task's recorded activity into a fixed-length series the monitor can draw directly.
 *
 * Computed at READ time from timestamps, so every viewer of the same task sees the same shape
 * — including one that opened the panel late, or re-opened it after the run finished. The
 * panel used to accumulate this itself from the polls it happened to observe, which meant the
 * history died with the panel.
 *
 * `counts[i]` is how many provider events landed in bucket i; `phases[i]` is which act was
 * live. A zero count is real information — it is the worker being quiet, not missing data.
 */
export function bucketActivity(
  entry: TaskEntry | undefined,
  now = Date.now(),
): { counts: number[]; phases: Array<1 | 2> } | null {
  // An evicted or unknown entry simply has no shape to draw — that is a normal outcome for a
  // task whose registry record has aged out, not an error worth casting around.
  if (!entry || entry.activity.length === 0) return null;
  const end = entry.terminalAt ?? now;
  const span = Math.max(1, end - entry.startedAt);
  const counts = new Array<number>(ACTIVITY_BUCKETS).fill(0);
  const phases = new Array<1 | 2>(ACTIVITY_BUCKETS).fill(1);
  for (const sample of entry.activity) {
    const ratio = (sample.at - entry.startedAt) / span;
    const i = Math.min(ACTIVITY_BUCKETS - 1, Math.max(0, Math.floor(ratio * ACTIVITY_BUCKETS)));
    counts[i] += 1;
    if (sample.phase === 2) phases[i] = 2;
  }
  // Phase is monotonic in the engine, so make it monotonic here too: a bucket with no samples
  // sitting after the review began still belongs to the review.
  let seen: 1 | 2 = 1;
  for (let i = 0; i < ACTIVITY_BUCKETS; i += 1) {
    if (phases[i] === 2) seen = 2;
    phases[i] = seen;
  }
  return { counts, phases };
}

export function buildRunningSnapshot(entry: TaskEntry, now = Date.now()): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    ...taskIdentity(entry),
    status: 'running',
    phase: entry.phase ?? 'implementing',
    elapsedMs: now - entry.startedAt,
    // Without a phase start, phase elapsed IS task elapsed.
    phaseElapsedMs: entry.phaseStartedAt ? now - entry.phaseStartedAt : now - entry.startedAt,
    startedAt: new Date(entry.startedAt).toISOString(),
  };
  if (entry.cancellationRequestedAt !== null) snapshot.cancellationRequested = true;
  if (entry.tool === 'execute_plan' && entry.totalTasks != null) snapshot.totalTasks = entry.totalTasks;
  // What the worker is doing right now, derived from provider activity. Complements the
  // type rather than replacing it: `type` is which route you launched, the headline is
  // which file it is reading this second.
  if (entry.runningHeadline !== null) snapshot.runningHeadline = entry.runningHeadline;
  const activity = bucketActivity(entry, now);
  if (activity) {
    snapshot.activity = activity.counts;
    snapshot.activityPhases = activity.phases;
  }
  return snapshot;
}
