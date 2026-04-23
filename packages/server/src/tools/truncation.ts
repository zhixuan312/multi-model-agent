interface TruncatableResult {
  status: string;
  output: string;
  filesWritten: string[];
  error?: string;
}

function buildSuffix(batchId: string, taskIndex: number, originalLength: number, truncatedLength: number): string {
  return `\n\n[Output truncated at ${truncatedLength}/${originalLength} chars. Use get_batch_slice({ batchId: "${batchId}", taskIndex: ${taskIndex} }) to fetch full output.]`;
}

/**
 * Truncate result outputs to stay within a combined character budget.
 *
 * When combined output exceeds the threshold, the budget is allocated equally
 * across all tasks. Short tasks are left intact and their surplus is
 * redistributed proportionally to oversized ones. Oversized outputs are
 * truncated at valid Unicode codepoint boundaries and annotated with a
 * get_batch_slice suffix.
 */
export function truncateResults<T extends TruncatableResult>(
  results: T[],
  batchId: string,
  threshold: number,
): T[] {
  const totalChars = results.reduce((sum, r) => sum + r.output.length, 0);
  if (totalChars <= threshold) return results;

  // Compute actual suffix lengths per result (not a fixed estimate)
  const suffixLengths = results.map((_, i) =>
    buildSuffix(batchId, i, 999999, 999999).length,
  );
  const suffixReserve = suffixLengths.reduce((sum, l) => sum + l, 0);
  // Content budget is threshold minus suffix overhead, clamped to [0, threshold]
  const contentBudget = Math.max(0, threshold - suffixReserve);
  const perTaskShare = Math.floor(contentBudget / results.length);

  // First pass: identify short (fits in share) vs oversized
  const shortIndices: number[] = [];
  const oversizedIndices: number[] = [];
  let surplusBudget = 0;

  for (let i = 0; i < results.length; i++) {
    if (results[i].output.length <= perTaskShare) {
      shortIndices.push(i);
      surplusBudget += perTaskShare - results[i].output.length;
    } else {
      oversizedIndices.push(i);
    }
  }

  // Redistribute surplus proportionally to oversized outputs
  const totalOversized = oversizedIndices.reduce((sum, i) => sum + results[i].output.length, 0);

  return results.map((r, i) => {
    if (shortIndices.includes(i)) return r; // fits, no truncation

    let budget = perTaskShare;
    if (totalOversized > 0 && surplusBudget > 0) {
      budget += Math.floor(surplusBudget * (r.output.length / totalOversized));
    }

    // Truncate at valid Unicode boundary (avoid splitting surrogate pairs)
    let truncPoint = Math.min(budget, r.output.length);
    if (truncPoint > 0 && truncPoint < r.output.length) {
      const code = r.output.charCodeAt(truncPoint - 1);
      // Don't split after a high surrogate (would orphan it)
      if (code >= 0xD800 && code <= 0xDBFF) truncPoint--;
      // Don't split on a low surrogate (would orphan the preceding high)
      const codeAt = r.output.charCodeAt(truncPoint);
      if (codeAt >= 0xDC00 && codeAt <= 0xDFFF && truncPoint > 0) truncPoint--;
    }

    const truncatedOutput =
      r.output.slice(0, truncPoint) +
      buildSuffix(batchId, i, r.output.length, truncPoint);

    return { ...r, output: truncatedOutput };
  });
}
