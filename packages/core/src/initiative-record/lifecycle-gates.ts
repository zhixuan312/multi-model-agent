/**
 * Initiative Record — pure advisory Lifecycle gate evaluator (SPEC-004 Lifecycle Engine).
 *
 * TRANSCRIPTION, not design: transcribes the "gate evaluation" rules in
 * `.mma/specs/2026-08-13-spec-004-lifecycle-engine.md` (SPEC-004, FR-5, FR-6, FR-8) that
 * Task I-3 owns as its own dedicated Output. Task I-2 creates this module early — per its
 * own task context — because `sqlite-store.ts`'s `initiative_phase_satisfy` and
 * `initiative_focus_set` mutations must compute and record a `gate_snapshot` before Task
 * I-3 formally lands; the alternative (duplicating this logic inline in the store) is
 * explicitly disallowed. Task I-3 owns refining/extending this file and adding its own
 * dedicated test coverage and public barrel exports.
 *
 * This module performs NO database read or write, NO caching, and NO mutation of its
 * inputs. It is a pure function of already-read record data. The store
 * (`sqlite-store.ts`) is the only database owner and is the only caller — for both live
 * reads and required mutation snapshots.
 */
import type {
  AcceptanceCriterion,
  Decision,
  DeliverableValidationState,
  Establishment,
  Event,
  GateEstablishmentResult,
  GateStatus,
  LifecycleContract,
  Phase,
  Requirement,
} from './types.js';

/** The already-read record data one gate evaluation needs — the store supplies all of it. */
export interface EvaluateLifecycleGateInput {
  /** The Initiative's currently selected Lifecycle Contract, or `null` when none applies. */
  contract: LifecycleContract | null;
  /** The phase whose gate is being evaluated. */
  phase: Phase;
  requirements: readonly Requirement[];
  acceptanceCriteria: readonly AcceptanceCriterion[];
  decisions: readonly Decision[];
  /**
   * Initiative-scoped lifecycle Events, chronological (`event_sequence` ascending). The
   * store may append one prospective (not-yet-persisted) `phase_satisfied` Event at the
   * current mutation's future sequence number so a satisfy's own current-request
   * assertions count toward its own snapshot (SPEC-004 "Data model").
   */
  events: readonly Event[];
  /**
   * SPEC-007 (Task I-7, ← AC-1.11): the current `validation_state` of every Deliverable
   * belonging to the Initiative, in any order. Drives the `deliverables_valid` satisfier —
   * an empty array (no Deliverables) satisfies it vacuously.
   */
  deliverableValidationStates: readonly DeliverableValidationState[];
}

/** A user-readable `detail` string for one Establishment, used whether it is satisfied or missing. */
function detailFor(establishment: Establishment): string {
  switch (establishment.satisfier) {
    case 'requirements_exist':
      return `At least one Requirement must be recorded (establishment '${establishment.key}').`;
    case 'acceptance_criteria_exist':
      return `At least one Acceptance Criterion must be recorded (establishment '${establishment.key}').`;
    case 'decisions_settled':
      return `Every recorded Decision must reach a non-'open' status (establishment '${establishment.key}').`;
    case 'manual':
      return `Manual establishment '${establishment.key}' has not been asserted for this phase and contract.`;
    case 'deliverables_valid':
      return `Every Deliverable must be 'valid' or 'human_approved' (establishment '${establishment.key}').`;
    default: {
      const unhandled: never = establishment.satisfier;
      return `Unknown satisfier for establishment '${establishment.key}': ${String(unhandled)}.`;
    }
  }
}

/**
 * Builds a lookup from Event sequence to the effective Lifecycle Contract id active at
 * that sequence, reconstructed from the current Initiative contract and chronological
 * `lifecycle_contract_set` Events (SPEC-004 "Data model" — `previous_lifecycle_contract`/
 * `new_lifecycle_contract` are the frozen payload keys). With no contract-set Events, the
 * contract has never changed, so every sequence resolves to `currentContractId`.
 */
function buildContractResolver(
  events: readonly Event[],
  currentContractId: string,
): (sequence: number) => string | null {
  const contractSets = events
    .filter((event) => event.event_type === 'lifecycle_contract_set')
    .slice()
    .sort((a, b) => a.event_sequence - b.event_sequence);
  const initial: string | null =
    contractSets.length > 0
      ? ((contractSets[0]!.payload as { previous_lifecycle_contract: string | null }).previous_lifecycle_contract ??
        null)
      : currentContractId;
  return (sequence: number): string | null => {
    let effective = initial;
    for (const contractSet of contractSets) {
      if (contractSet.event_sequence > sequence) break;
      effective =
        (contractSet.payload as { new_lifecycle_contract: string | null }).new_lifecycle_contract ?? null;
    }
    return effective;
  };
}

/**
 * `manual` satisfier (SPEC-004 FR-6): true only for a prior `phase_satisfied` Event of the
 * same phase whose `asserted` includes `key` and whose effective Lifecycle Contract id (at
 * that Event's position) equals the currently selected contract's id. Voided by ignoring
 * every candidate assertion at or before the latest same-phase `phase_reopened` Event, and
 * at or before a same-phase `phase_entered` Event with `previous_state: 'satisfied'` — "both
 * supported exits from satisfied" (SPEC-004 "Data model").
 */
function isManualAsserted(
  key: string,
  phase: Phase,
  currentContractId: string,
  events: readonly Event[],
): boolean {
  const samePhase = events.filter(
    (event) =>
      (event.event_type === 'phase_satisfied' ||
        event.event_type === 'phase_reopened' ||
        event.event_type === 'phase_entered') &&
      (event.payload as { phase?: unknown }).phase === phase,
  );

  let voidSequence = -Infinity;
  for (const event of samePhase) {
    if (event.event_type === 'phase_reopened') {
      voidSequence = Math.max(voidSequence, event.event_sequence);
    } else if (
      event.event_type === 'phase_entered' &&
      (event.payload as { previous_state?: unknown }).previous_state === 'satisfied'
    ) {
      voidSequence = Math.max(voidSequence, event.event_sequence);
    }
  }

  const contractAt = buildContractResolver(events, currentContractId);
  for (const event of samePhase) {
    if (event.event_type !== 'phase_satisfied') continue;
    if (event.event_sequence <= voidSequence) continue;
    const asserted = (event.payload as { asserted?: unknown }).asserted;
    if (!Array.isArray(asserted) || !asserted.includes(key)) continue;
    if (contractAt(event.event_sequence) !== currentContractId) continue;
    return true;
  }
  return false;
}

/**
 * `deliverables_valid` satisfier (SPEC-007, Task I-7, ← AC-1.11): true only when every
 * Deliverable's `validation_state` is `valid` or `human_approved`. An empty array (no
 * Deliverables) is true — every member of an empty set satisfies the predicate.
 */
function isDeliverablesValid(deliverableValidationStates: readonly DeliverableValidationState[]): boolean {
  return deliverableValidationStates.every((state) => state === 'valid' || state === 'human_approved');
}

function isEstablishmentSatisfied(
  establishment: Establishment,
  phase: Phase,
  contractId: string,
  requirements: readonly Requirement[],
  acceptanceCriteria: readonly AcceptanceCriterion[],
  decisions: readonly Decision[],
  events: readonly Event[],
  deliverableValidationStates: readonly DeliverableValidationState[],
): boolean {
  switch (establishment.satisfier) {
    case 'requirements_exist':
      return requirements.length > 0;
    case 'acceptance_criteria_exist':
      return acceptanceCriteria.length > 0;
    case 'decisions_settled':
      return !decisions.some((decision) => decision.status === 'open');
    case 'manual':
      return isManualAsserted(establishment.key, phase, contractId, events);
    case 'deliverables_valid':
      return isDeliverablesValid(deliverableValidationStates);
    default:
      // An impossible malformed internal Establishment (a satisfier outside the closed
      // vocabulary — e.g. corrupted stored `definition_json`) is never silently treated
      // as satisfied; the store's own validation boundary is the typed-error surface for
      // a caller-visible malformed contract, so this module just reads it as unmet.
      return false;
  }
}

/**
 * Evaluates one phase's live, advisory Lifecycle gate (SPEC-004 FR-8). `green` with
 * `missing: []` only when every required Establishment for `phase` is satisfied;
 * otherwise `red` with the exact missing entries. A `null` contract always reads green
 * with the frozen note — an advisory gate NEVER blocks any caller-requested transition,
 * whatever its colour.
 */
export function evaluateLifecycleGate(input: EvaluateLifecycleGateInput): GateStatus {
  const { contract, phase, requirements, acceptanceCriteria, decisions, events, deliverableValidationStates } = input;
  if (!contract) {
    return { status: 'green', missing: [], establishments: [], note: 'No lifecycle contract is set.' };
  }
  const required = contract.phases[phase]?.required ?? [];
  // FR-8 asks for a result for EACH required Establishment, not only the failing ones. Reporting
  // just `missing` left a caller unable to tell "checked and satisfied" from "not in this contract
  // at all" — the deliver gate lists only `delivery_confirmed` when `deliverables_valid` is
  // present and vacuously satisfied, which reads exactly like the establishment is absent.
  const establishments: GateEstablishmentResult[] = required.map((establishment) => {
    const satisfied = isEstablishmentSatisfied(
      establishment,
      phase,
      contract.id,
      requirements,
      acceptanceCriteria,
      decisions,
      events,
      deliverableValidationStates,
    );
    return { establishment, satisfied, detail: detailFor(establishment) };
  });
  const missing = establishments.filter((result) => !result.satisfied);
  return missing.length === 0
    ? { status: 'green', missing: [], establishments }
    : { status: 'red', missing, establishments };
}
