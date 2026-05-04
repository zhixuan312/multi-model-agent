import type { AgentType } from '../types.js';

/**
 * Returns the inverse tier in a binary tier system (standard ↔ complex).
 *
 * In v4.0, the tier system is binary — the "other tier" is always exactly
 * one deterministic value. This is the single source of truth for tier
 * rotation logic, used by escalation/fallback and eventually by
 * EscalationPolicy.rotateImpl (Phase 3.24) to structurally guarantee
 * reviewer-tier separation without runtime forbiddenTiers checks.
 */
export function otherTier(t: AgentType): AgentType {
  return t === 'standard' ? 'complex' : 'standard';
}
