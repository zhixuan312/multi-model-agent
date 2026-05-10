/**
 * Runaway-loop safety net. Applies to ALL provider runs (implementer,
 * sub-worker, reviewer, annotator) across ALL routes (artifact-producing
 * and read-only).
 *
 * Real budgets are user-configurable: timeoutMs (wall-clock), maxCostUSD
 * (cost), stallTimeoutMs (idle watchdog wired in stall-watchdog.ts).
 * SAFETY_MAX_TURNS only catches degenerate providers that loop without
 * exceeding wall-clock — it should never be the binding constraint on
 * a real run.
 *
 * 200 turns at an average 30s/turn = 100 minutes of model time, well past
 * the 60-min DEFAULT_TASK_TIMEOUT_MS. Loop-detection (stall-detector.ts
 * detectToolCallLoop) catches actual repetition loops at any turn count.
 */
export const SAFETY_MAX_TURNS = 200;
