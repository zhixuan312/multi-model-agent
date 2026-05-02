export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

// CanonicalUsage is a normalized internal shape. Runtime validation of provider
// payloads is handled at provider parsing / Zod schema boundaries; this helper is
// intentionally a pure accumulator that preserves null-as-unexposed semantics.
export function makeEmptyUsage(): CanonicalUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: null, reasoningTokens: null };
}

export function mergeUsage(acc: CanonicalUsage, turn: CanonicalUsage): CanonicalUsage {
  return normalizeUsageToSubset({
    inputTokens: acc.inputTokens + turn.inputTokens,
    outputTokens: acc.outputTokens + turn.outputTokens,
    cachedTokens: acc.cachedTokens === null && turn.cachedTokens === null
      ? null
      : (acc.cachedTokens ?? 0) + (turn.cachedTokens ?? 0),
    reasoningTokens: acc.reasoningTokens === null && turn.reasoningTokens === null
      ? null
      : (acc.reasoningTokens ?? 0) + (turn.reasoningTokens ?? 0),
  });
}

/**
 * Enforce subset semantics (cachedTokens ⊆ inputTokens). Claude and
 * DeepSeek (via claude-compatible) report sibling semantics where
 * cachedTokens is separate from inputTokens. When we detect sibling
 * output (cached > input), we lift inputTokens by adding cachedTokens
 * so that downstream consumers — `computeCostBreakdown` and telemetry
 * schema validation — see a valid subset relationship.
 */
export function normalizeUsageToSubset(usage: CanonicalUsage): CanonicalUsage {
  if (usage.cachedTokens != null && usage.cachedTokens > usage.inputTokens) {
    return { ...usage, inputTokens: usage.inputTokens + usage.cachedTokens };
  }
  return usage;
}
