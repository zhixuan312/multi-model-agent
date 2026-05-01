export const clampStageCost = (n: number): number =>
  Math.max(0, Math.min(Math.round(n * 1_000_000) / 1_000_000, 100));

export const clampTaskCost = (n: number): number =>
  Math.max(0, Math.min(n, 800));

export const clampInputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 5_000_000);

export const clampOutputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 500_000);

export const clampCachedTokens = (n: number): number =>
  Math.min(Math.max(0, n), 5_000_000);

export const clampReasoningTokens = (n: number): number =>
  Math.min(Math.max(0, n), 500_000);

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
