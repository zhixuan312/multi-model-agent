import type { AgentType } from '../types.js';

export type ReworkLoop = 'spec' | 'quality';

// Note: FallbackReason is defined in fallback.ts (Task 5) and re-exported from
// the escalation/index.ts barrel. Don't duplicate it here — round-1 audit #37.

/** A single attempt's tier assignments. `null` impl means review-only row
 *  (only used for quality loop's index 0). */
export interface AttemptAssignment {
  impl: AgentType | null;
  reviewer: AgentType;
}

export interface EscalationDecision {
  /** Tier of the implementer for this attempt. */
  impl: AgentType;
  /** Tier of the reviewer for the review that follows this impl. */
  reviewer: AgentType;
  /** True when this attempt swaps off the base tier (used for diagnostics). */
  isEscalated: boolean;
}

// Spec loop: indexed 0 (initial impl) → 1 (rework 1) → 2 (rework 2 = "last try")
export const SPEC_LOOP_STANDARD: AttemptAssignment[] = [
  { impl: 'standard', reviewer: 'complex' },
  { impl: 'standard', reviewer: 'complex' },
  { impl: 'complex',  reviewer: 'standard' },
];

// Quality loop: indexed 0 (initial review of inherited impl, no rework yet)
//                       → 1 (rework 1) → 2 (rework 2 = "last try")
export const QUALITY_LOOP_STANDARD: AttemptAssignment[] = [
  { impl: null,       reviewer: 'complex' },
  { impl: 'standard', reviewer: 'complex' },
  { impl: 'complex',  reviewer: 'standard' },
];

// Complex-tier tasks: no policy swap; every row stays on complex impl + standard reviewer
export const SPEC_LOOP_COMPLEX: AttemptAssignment[] = [
  { impl: 'complex', reviewer: 'standard' },
  { impl: 'complex', reviewer: 'standard' },
  { impl: 'complex', reviewer: 'standard' },
];
export const QUALITY_LOOP_COMPLEX: AttemptAssignment[] = [
  { impl: null,      reviewer: 'standard' },
  { impl: 'complex', reviewer: 'standard' },
  { impl: 'complex', reviewer: 'standard' },
];

function pickTable(loop: ReworkLoop, baseTier: AgentType): AttemptAssignment[] {
  if (loop === 'spec') return baseTier === 'standard' ? SPEC_LOOP_STANDARD : SPEC_LOOP_COMPLEX;
  return baseTier === 'standard' ? QUALITY_LOOP_STANDARD : QUALITY_LOOP_COMPLEX;
}

export function pickEscalation(input: {
  loop: ReworkLoop;
  attemptIndex: number;
  baseTier: AgentType;
}): EscalationDecision {
  const table = pickTable(input.loop, input.baseTier);
  if (input.attemptIndex < 0 || input.attemptIndex >= table.length) {
    throw new Error(
      `pickEscalation: attemptIndex ${input.attemptIndex} out of range for ` +
      `${input.loop}/${input.baseTier} (max ${table.length - 1})`,
    );
  }
  const row = table[input.attemptIndex];
  if (row.impl === null) {
    throw new Error(
      `pickEscalation: ${input.loop} attempt ${input.attemptIndex} has no impl row — ` +
      `caller asked for impl tier on a review-only row`,
    );
  }
  return {
    impl: row.impl,
    reviewer: row.reviewer,
    isEscalated: row.impl !== input.baseTier,
  };
}

export function pickReviewer(input: {
  loop: ReworkLoop;
  attemptIndex: number;
  baseTier: AgentType;
}): AgentType {
  const table = pickTable(input.loop, input.baseTier);
  if (input.attemptIndex < 0 || input.attemptIndex >= table.length) {
    throw new Error(
      `pickReviewer: attemptIndex ${input.attemptIndex} out of range for ` +
      `${input.loop}/${input.baseTier} (max ${table.length - 1})`,
    );
  }
  return table[input.attemptIndex].reviewer;
}

/** Total number of policy rows in the loop (includes review-only rows). Returns 3. */
export function maxRowsFor(_loop: ReworkLoop): number {
  return 3;
}

/** Number of reworks (impl attempts after initial). Returns 2 for both loops.
 *  Loop-aware: spec excludes the initial-impl row (length - 1); quality has no
 *  initial-impl row, so reworks = total impl rows. */
export function maxReworksFor(loop: ReworkLoop): number {
  const table = pickTable(loop, 'standard');
  const implRows = table.filter(r => r.impl !== null).length;
  return loop === 'spec' ? implRows - 1 : implRows;
}
