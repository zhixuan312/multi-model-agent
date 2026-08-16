export type AgentType = 'standard' | 'complex' | 'main';
/** Reasoning-effort ladder both runtimes share. claude-agent-sdk exposes
 *  low|medium|high|xhigh|max (no 'none' — that is `thinking: disabled`);
 *  codex CLI exposes none|minimal|low|medium|high|xhigh|max|ultra. The
 *  intersection plus 'none' is what mma offers, so a level means the same
 *  thing on every tier. codex-only 'minimal'/'ultra' are deliberately absent.
 *  Both runtimes clamp a level their model does not support (claude downgrades
 *  silently; codex clamps to its catalog's supported_reasoning_levels). */
export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Applied to every agent tier unless the config sets `effort` for that tier.
 *  Models whose profile says `supportsEffort: false` never receive it — see
 *  providers/effort.ts. */
export const DEFAULT_EFFORT: Effort = 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed';

