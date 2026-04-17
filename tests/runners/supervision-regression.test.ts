import {
  validateCompletion,
  buildRePrompt,
  type DegenerateKind,
} from '../../packages/core/src/runners/supervision.js';

/**
 * Captured degenerate outputs from the 2026-04-10 audit dispatches.
 * These are real strings the runners returned during the failed audit.
 * Each one MUST trigger the appropriate Tier-1 detector and produce
 * the corresponding re-prompt. Any future change to validateCompletion
 * or buildRePrompt that breaks these tests is a regression by definition.
 *
 * Source: spec sections "Regression test from real captured outputs"
 * and Part A.2.2.
 */
describe('supervision: real degenerate outputs from 2026-04-10 audit', () => {
  interface Case {
    label: string;
    input: string;
    expectedKind: DegenerateKind;
    expectedRePromptFragment: string;
  }

  const invalidCases: Case[] = [
    {
      label: 'Tally minimax attempt 1 (empty)',
      input: '',
      expectedKind: 'empty',
      expectedRePromptFragment: 'previous response was empty',
    },
    {
      label: 'Liquidity minimax attempt 1 (mid-exploration fragment)',
      input: 'Now let me check the SSE hook and BottomNav:',
      expectedKind: 'fragment',
      expectedRePromptFragment: 'exploration fragment',
    },
    {
      label: 'Pure-thinking message (synthesised from stripThinkingTags marker)',
      input: '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
      expectedKind: 'thinking_only',
      expectedRePromptFragment: '<think>',
    },
  ];

  it.each(invalidCases)('$label is detected and re-prompted appropriately', ({ input, expectedKind, expectedRePromptFragment }) => {
    const result = validateCompletion(input);
    expect(result.valid).toBe(false);
    expect(result.kind).toBe(expectedKind);
    const prompt = buildRePrompt(result);
    expect(prompt).toContain(expectedRePromptFragment);
  });

  // These outputs contain continuation phrases and are under FRAGMENT_MAX_LENGTH
  // (120 chars), so fragment detection correctly catches them regardless of
  // DEFAULT_MIN_LENGTH. With MAX_DEGENERATE_RETRIES=3 (down from 10), the cost
  // of catching real fragments is bounded.
  it.each([
    {
      label: 'Tally minimax attempt 2 (grep limitation confession)',
      input: 'The grep tool only works on individual files. Let me read key files directly instead.',
      expectedKind: 'fragment' as const,
      expectedRePromptFragment: 'exploration fragment',
    },
    {
      label: 'Fate minimax attempt 2 (cut off mid-plan)',
      input: 'Let me check specific files for the remaining items:',
      expectedKind: 'fragment' as const,
      expectedRePromptFragment: 'exploration fragment',
    },
  ])('$label is detected and re-prompted appropriately', ({ input, expectedKind, expectedRePromptFragment }) => {
    const result = validateCompletion(input);
    expect(result.valid).toBe(false);
    expect(result.kind).toBe(expectedKind);
    const prompt = buildRePrompt(result);
    expect(prompt).toContain(expectedRePromptFragment);
  });
});
