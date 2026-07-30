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
  /** Ids the reviewer marked `done`. Only meaningful when `matched`. */
  readonly doneIds: readonly string[];
  /** Ids the reviewer did NOT mark done — the answer to "which task isn't finished?". */
  readonly notDoneIds: readonly string[];
}

/** Derive the dispatched task records from a parsed plan. */
export function dispatchedTasksFromSnapshot(snapshot: ContractPlanSnapshot): DispatchedContractTask[] {
  return snapshot.tasks.map((t) => ({ id: t.id, title: t.title }));
}

/**
 * Pull a task id out of ANY reasonable selector spelling.
 *
 * Task identity is one scheme — the id — and this is the single place a caller-supplied string
 * becomes one. The id is embedded in the heading itself (`### Task I-1: Do the thing (← AC-1.1)`),
 * so every spelling below resolves through the SAME key rather than through a parallel
 * title-comparison path:
 *
 *   "I-1"                                    → I-1
 *   "Task I-1"                               → I-1
 *   "Task I-1: Do the thing (← AC-1.1)"      → I-1
 *   "### Task I-1: Do the thing"             → I-1
 *
 * That matters because selectors are hand-authored against a rendered plan. Requiring a
 * byte-exact title was the selector-side twin of the reviewer-echo bug: a caller who copied a
 * heading and dropped the `(← AC-…)` annotation got `no_match` on correct input.
 */
export function extractTaskId(selector: string): string | null {
  const m = selector.match(/\b([IVXLCDM]+-\d+)\b/i);
  return m ? m[1]!.toUpperCase() : null;
}

export type SelectorResolution =
  | { ok: true; ids: string[] }
  | { ok: false; unresolvable: string[]; duplicated: string[]; availableTaskIds: string[] };

/**
 * Resolve caller-supplied task selectors onto dispatched task ids, one-to-one. An empty
 * selector list means "every task" and is the caller's business, not this function's.
 */
export function resolveSelectors(
  selectors: readonly string[],
  dispatched: readonly DispatchedContractTask[],
): SelectorResolution {
  const known = new Set(dispatched.map((t) => t.id));
  const availableTaskIds = dispatched.map((t) => t.id);

  const resolved: string[] = [];
  const unresolvable: string[] = [];
  for (const sel of selectors) {
    const id = extractTaskId(sel);
    if (id === null || !known.has(id)) unresolvable.push(sel);
    else resolved.push(id);
  }

  const duplicated = resolved.filter((id, i) => resolved.indexOf(id) !== i);
  if (unresolvable.length > 0 || duplicated.length > 0) {
    return { ok: false, unresolvable, duplicated: [...new Set(duplicated)], availableTaskIds };
  }
  return { ok: true, ids: resolved };
}

/** FR-11 — name what WOULD have matched, not only what failed. */
export function describeSelectorFailure(r: Extract<SelectorResolution, { ok: false }>): string {
  const parts: string[] = [];
  if (r.unresolvable.length > 0) {
    parts.push(`no Contract Task matches: ${r.unresolvable.map((s) => JSON.stringify(s)).join(', ')}`);
  }
  if (r.duplicated.length > 0) {
    parts.push(`selector(s) resolved to the same task twice: ${r.duplicated.join(', ')}`);
  }
  return `${parts.join('; ')}. Available task ids: ${r.availableTaskIds.join(', ') || '(none)'}.`;
}

function unmatched(
  availableTaskIds: readonly string[],
  unknownIds: readonly string[] = [],
  missingIds: readonly string[] = [],
): ContractMatchResult {
  return { matched: false, allDone: false, availableTaskIds, unknownIds, missingIds, doneIds: [], notDoneIds: [] };
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
  const doneIds: string[] = [];
  const notDoneIds: string[] = [];

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
    if (t.status === 'done') doneIds.push(t.id);
    else notDoneIds.push(t.id);
  }

  if (unknownIds.length > 0 || remaining.size > 0) {
    return unmatched(availableTaskIds, unknownIds, [...remaining]);
  }

  return {
    matched: true,
    allDone: notDoneIds.length === 0,
    availableTaskIds,
    unknownIds: [],
    missingIds: [],
    doneIds,
    notDoneIds,
  };
}

/**
 * Per-task completion as a percentage — the answer to "how much of the plan actually landed?".
 *
 * Derived from the reviewer's per-task verdicts rather than being a fixed score, so a run that
 * finished 3 of 4 tasks reports 75 and names the fourth. Returns null when matching failed: we
 * genuinely cannot score it, and inventing a number would be worse than saying so.
 */
export function taskCompletionPercent(result: ContractMatchResult): number | null {
  if (!result.matched) return null;
  const total = result.doneIds.length + result.notDoneIds.length;
  if (total === 0) return 100;
  return Math.round((result.doneIds.length / total) * 100);
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
