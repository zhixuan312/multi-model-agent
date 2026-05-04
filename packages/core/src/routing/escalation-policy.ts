import type { AgentType } from '../types.js';
import { otherTier } from './tier-policy.js';

export type ToolCategory = 'artifact_producing' | 'read_only' | 'research';

export const ATTEMPT_BUDGETS: Record<ToolCategory, number> = {
  artifact_producing: 7,    // 3 spec + 3 quality + 1 diff
  read_only: 2,              // 1 implementer + 1 annotator (no rework)
  research: 3,               // explore-style (no review)
};

export class EscalationPolicy {
  /**
   * Returns the tier to use for the implementer at the given chain attempt.
   * Per spec § C9 (overall.md lines 1247-1252): attempts 0 and 1 hold the caller's tier;
   * attempt 2 (the 3rd try) rotates to otherTier. attempt >= 3 means budget exhausted.
   */
  rotateImpl(currentTier: AgentType, attempt: number): AgentType {
    if (attempt < 0) throw new Error(`attempt must be >= 0, got ${attempt}`);
    if (attempt >= 3) throw new Error(`per-chain attempt budget exhausted (attempt=${attempt}); chain should have terminated`);
    if (attempt === 2) return otherTier(currentTier);   // 3rd attempt rotates
    return currentTier;                                  // attempts 0 + 1 hold caller tier
  }

  /**
   * Reviewer always sits on otherTier of the current implementer tier.
   * On attempt 2 when implementer rotated, reviewer auto-flips back to the caller's original tier.
   */
  rotateReviewer(currentImplTier: AgentType): AgentType {
    return otherTier(currentImplTier);
  }

  attemptBudget(category: ToolCategory): number {
    return ATTEMPT_BUDGETS[category];
  }
}
