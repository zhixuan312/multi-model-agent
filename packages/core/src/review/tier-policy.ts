import type { AgentType } from '../types.js';

/**
 * Cross-tier inversion: reviewer runs on the OPPOSITE tier as a
 * "second-opinion needs a different perspective" policy.
 *   implementer=standard → reviewer=complex
 *   implementer=complex  → reviewer=standard
 * If the inverted tier has no provider configured, callers should fall
 * back to the implementer tier and emit a validation_warnings diagnostic.
 */
export function invertedReviewerTier(implementerTier: AgentType): AgentType {
  return implementerTier === 'complex' ? 'standard' : 'complex';
}
