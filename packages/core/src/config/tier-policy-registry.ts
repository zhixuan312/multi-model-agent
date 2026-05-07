import type { AgentType } from '../types.js';

/**
 * Returns the inverse tier in a binary tier system (standard ↔ complex).
 *
 * In v4.0, the tier system is binary — the "other tier" is always exactly
 * one deterministic value. This is the single source of truth for tier
 * rotation logic. Reviewer-implementer separation is guaranteed
 * structurally by the policy tables in `escalation/policy.ts` (each row
 * pins impl ≠ reviewer); there are no runtime tier-exclusion checks.
 */
export function otherTier(t: AgentType): AgentType {
  return t === 'standard' ? 'complex' : 'standard';
}
