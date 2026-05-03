import { describe, it, expect } from 'vitest';

// Helper: shape a minimal currentResult that openAIUsage can consume.
// `extractCanonicalTokens` reads `state.usage` for inputTokens/outputTokens and
// `state.usage.inputTokensDetails[].cached_tokens` for cachedTokens.
function makeFakeOpenAIResultWith(opts: { inputTokens: number; cachedTokens: number; outputTokens: number }) {
  return {
    state: {
      usage: {
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        totalTokens: opts.inputTokens + opts.outputTokens,
        inputTokensDetails: [{ cached_tokens: opts.cachedTokens }],
        outputTokensDetails: [{ reasoning_tokens: 0 }],
      },
    },
  } as any;
}

describe('Item 14: runners pass cachedTokens to computeCostUSD', () => {
  it('cost reflects cache discount on a 14:1 cached:input run (after R6a)', async () => {
    // Dynamically import so we test the actual module
    const { openAIUsage } = await import('../../packages/core/src/runners/openai-runner.js');
    const fakeResult = makeFakeOpenAIResultWith({ inputTokens: 917000, cachedTokens: 860000, outputTokens: 10000 });
    const config = { type: 'claude-compatible' as const, model: 'deepseek-v4-pro', apiKey: 'k' };
    const u = openAIUsage(fakeResult, config);
    // Without cache discount: 917000 * 0.435/M = $0.399
    // With discount on 860k: (57000 * 0.435 + 860000 * 0.0435)/M = $0.024 + $0.037 = $0.062
    expect(u.costUSD).toBeLessThan(0.10);  // significantly less than retail
    expect(u.costUSD).toBeGreaterThan(0.04);  // but reasonable
  });

  // Item 15 verification: costDeltaVsParentUSD math is correct after R6a + R6b.
  // Parent model (Claude Sonnet) at 3/M input, 0.3/M cached, 15/M output.
  // Actual deepseek cost ~$0.06; Claude parent cost = (57000*3 + 860000*0.3 + 10000*15)/M = $0.171 + $0.258 + $0.15 = $0.579
  // Delta = actual - parent = 0.06 - 0.579 = -0.519 (we paid LESS).
  it('Item 15: costDeltaVsParentUSD < 0 when implementer is cheaper than parent', async () => {
    const { openAIUsage } = await import('../../packages/core/src/runners/openai-runner.js');
    const fakeResult = makeFakeOpenAIResultWith({ inputTokens: 917000, cachedTokens: 860000, outputTokens: 10000 });
    const config = { type: 'claude-compatible' as const, model: 'deepseek-v4-pro', apiKey: 'k' };
    const u = openAIUsage(fakeResult, config, 'claude-sonnet-4-6');
    expect(u.costDeltaVsParentUSD).toBeLessThan(0);
  });
});
