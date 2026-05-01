export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

export function makeEmptyUsage(): CanonicalUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: null, reasoningTokens: null };
}

export function mergeUsage(acc: CanonicalUsage, turn: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: acc.inputTokens + turn.inputTokens,
    outputTokens: acc.outputTokens + turn.outputTokens,
    cachedTokens: acc.cachedTokens === null && turn.cachedTokens === null
      ? null
      : (acc.cachedTokens ?? 0) + (turn.cachedTokens ?? 0),
    reasoningTokens: acc.reasoningTokens === null && turn.reasoningTokens === null
      ? null
      : (acc.reasoningTokens ?? 0) + (turn.reasoningTokens ?? 0),
  };
}
