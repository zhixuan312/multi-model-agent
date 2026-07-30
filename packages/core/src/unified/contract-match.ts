import type { ContractPlanSnapshot } from './contract-plan.js';

/**
 * Contract satisfaction for `execute_plan`, keyed on STABLE TASK IDENTITY.
 *
 * Titles are prose a reviewer must retype; IDs (`I-1`, `I-2`, …) are stable keys parsed out of
 * the plan's own `### Task <id>: …` headings. Matching on titles made a reviewer's paraphrase
 * indistinguishable from unfinished work, so green tests plus a reworded title terminated as
 * `failed`. Matching on IDs removes that whole failure class.
 *
 * The result is deliberately NOT a boolean. `matched` (did we understand which tasks the
 * reviewer is talking about?) and `allDone` (did the reviewer say they are finished?) are
 * different questions with different owners: a match failure is OUR plumbing breaking, a
 * not-done status is the work genuinely being incomplete. Collapsing them is what caused
 * engine bugs to be reported to callers as "your work isn't done".
 */

export interface DispatchedContractTask {
  readonly id: string;
  readonly title: string;
}

export interface ContractMatchResult {
  /** Did every reviewer entry resolve one-to-one onto a dispatched task id? */
  readonly matched: boolean;
  /** Only meaningful when `matched` is true. */
  readonly allDone: boolean;
  /** Always populated — FR-11 requires the diagnostic to name what WOULD have matched. */
  readonly availableTaskIds: readonly string[];
  /** Ids the reviewer sent that we did not dispatch. Empty when `matched`. */
  readonly unknownIds: readonly string[];
  /** Ids we dispatched that the reviewer never mentioned. Empty when `matched`. */
  readonly missingIds: readonly string[];
}

/** Derive the dispatched task records from a parsed plan. */
export function dispatchedTasksFromSnapshot(snapshot: ContractPlanSnapshot): DispatchedContractTask[] {
  return snapshot.tasks.map((t) => ({ id: t.id, title: t.title }));
}

function unmatched(
  availableTaskIds: readonly string[],
  unknownIds: readonly string[] = [],
  missingIds: readonly string[] = [],
): ContractMatchResult {
  return { matched: false, allDone: false, availableTaskIds, unknownIds, missingIds };
}

/**
 * Resolve reviewer output against the dispatched tasks. Never throws: malformed reviewer output
 * is an unmatched result, not an exception, because the caller must be able to distinguish it
 * from incomplete work rather than from a crash.
 */
export function contractMatchFromReviewer(
  parsedData: unknown,
  dispatchedTasks: readonly DispatchedContractTask[] | undefined,
): ContractMatchResult {
  const dispatched = dispatchedTasks ?? [];
  const availableTaskIds = dispatched.map((t) => t.id);

  const data = parsedData as { tasks?: unknown } | null | undefined;
  const tasks = Array.isArray(data?.tasks)
    ? (data!.tasks as Array<{ id?: unknown; status?: unknown }>)
    : null;
  if (!tasks) return unmatched(availableTaskIds, [], availableTaskIds);

  const remaining = new Set(availableTaskIds);
  const unknownIds: string[] = [];
  let allDone = true;

  for (const t of tasks) {
    if (typeof t.id !== 'string' || t.id.length === 0) {
      // An entry with no usable identity makes the whole echo unresolvable.
      return unmatched(availableTaskIds, unknownIds, [...remaining]);
    }
    if (!remaining.has(t.id)) {
      // Unknown id, or a duplicate of one already consumed.
      unknownIds.push(t.id);
      continue;
    }
    remaining.delete(t.id);
    if (t.status !== 'done') allDone = false;
  }

  if (unknownIds.length > 0 || remaining.size > 0) {
    return unmatched(availableTaskIds, unknownIds, [...remaining]);
  }

  return { matched: true, allDone, availableTaskIds, unknownIds: [], missingIds: [] };
}

/** FR-11 — a diagnostic that names what would have matched, not only what failed. */
export function describeContractMismatch(result: ContractMatchResult): string {
  const parts: string[] = [];
  if (result.unknownIds.length > 0) {
    parts.push(`reviewer reported unknown task ids: ${result.unknownIds.join(', ')}`);
  }
  if (result.missingIds.length > 0) {
    parts.push(`reviewer omitted dispatched task ids: ${result.missingIds.join(', ')}`);
  }
  if (parts.length === 0) parts.push('reviewer output could not be resolved to dispatched tasks');
  return `${parts.join('; ')}. Available task ids: ${result.availableTaskIds.join(', ') || '(none)'}.`;
}
