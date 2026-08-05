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
  return snapshot;
}
