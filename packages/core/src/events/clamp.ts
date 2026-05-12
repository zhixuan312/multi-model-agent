// Telemetry clamp helpers.
//
// Defensive ceilings against corrupted / runaway values from provider
// adapters before persistence. Ceilings were raised in 2026-05 from the
// 2025-era 5M-input / 500K-output / $100-stage limits to current-era
// scale — codex with 1M-context plus heavy cached prefixes routinely
// exceeds 5M input tokens, and audit `subtype:plan` runs at this scale
// cost $20-$50 per stage.
//
// If you need to raise these again: bump these constants AND the
// matching `.max(...)` bounds in `telemetry-types.ts` (Zod schema).

export const clampStageCost = (n: number): number =>
  Math.max(0, Math.min(Math.round(n * 1_000_000) / 1_000_000, 500));

export const clampTaskCost = (n: number): number =>
  Math.max(0, Math.min(n, 5_000));

export const clampInputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 100_000_000);

export const clampOutputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 2_000_000);

export const clampCachedTokens = (n: number): number =>
  Math.min(Math.max(0, n), 100_000_000);

export const clampReasoningTokens = (n: number): number =>
  Math.min(Math.max(0, n), 2_000_000);

export const clampToolCallCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampFilesReadCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampFilesWrittenCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampTurnCount = (n: number): number =>
  Math.min(Math.max(0, n), 250);

export const clampDurationMsStage = (n: number): number =>
  Math.min(Math.max(0, n), 3_600_000);

export const clampDurationMsTotal = (n: number): number =>
  Math.min(Math.max(0, n), 86_400_000);
