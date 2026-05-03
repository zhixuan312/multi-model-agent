export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number | null;
  cachedCreationTokens: number | null;
  reasoningTokens: number | null;
}

export function makeEmptyUsage(): CanonicalUsage {
  return {
    inputTokens: 0, outputTokens: 0,
    cachedReadTokens: null, cachedCreationTokens: null,
    reasoningTokens: null,
  };
}

export function mergeUsage(acc: CanonicalUsage, turn: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: acc.inputTokens + turn.inputTokens,
    outputTokens: acc.outputTokens + turn.outputTokens,
    cachedReadTokens: nullSafeSum(acc.cachedReadTokens, turn.cachedReadTokens),
    cachedCreationTokens: nullSafeSum(acc.cachedCreationTokens, turn.cachedCreationTokens),
    reasoningTokens: nullSafeSum(acc.reasoningTokens, turn.reasoningTokens),
  };
}

function nullSafeSum(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
