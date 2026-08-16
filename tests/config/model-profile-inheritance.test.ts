/**
 * The three-layer resolution — provider defaults → parent profile → entry overrides.
 *
 * This is what `model-profile-registry.ts` mostly IS: 537 lines whose central job is merging a
 * hierarchical JSON file into flat profiles, and the two existing tests checked family lookup and
 * pricing sign. Nothing pinned the precedence, which matters because the merge writes some fields
 * more than once. `family` was written three times — once from the entry, once unconditionally
 * from the parent, once from the entry again — so it came out right only because of the ORDER of
 * two blocks that read like independent layers. Reordering them (apply defaults, then all
 * overrides) would have reverted every family override to its parent's, and every test here would
 * still have passed.
 *
 * Asserted through `findModelProfile`, the public surface, against the committed
 * `model-profiles.json` — so these are the values the engine actually charges and budgets with,
 * not a fixture standing in for them.
 */
import { describe, expect, it } from 'vitest';
import { findModelProfile } from '../../packages/core/src/config/model-profile-registry.js';

describe('model profile inheritance', () => {
  it('takes an unset field from the parent profile', () => {
    // `claude-haiku` declares no tier; `claude` (its parent) declares "standard".
    expect(findModelProfile('claude-haiku-4-5').tier).toBe('standard');
    // …and it really is inherited rather than a global default: a SIBLING that declares its own
    // tier gets that one instead, so "standard" above came from the `claude` parent.
    expect(findModelProfile('claude-opus-4-7').tier).toBe('reasoning');
  });

  it('lets the entry override the parent, field by field', () => {
    const parent = findModelProfile('claude-3-7');       // resolves to the `claude` catch-all
    const child = findModelProfile('claude-haiku-4-5');
    expect(parent.defaultCost).toBe('medium');
    expect(child.defaultCost).toBe('low');               // entry override wins
    expect(child.inputCostPerMTok).toBe(1);              // entry override wins
    expect(parent.inputCostPerMTok).toBe(3);
  });

  it('inherits pricing from the parent when the entry sets none', () => {
    // `gpt-5` overrides tier and softLimit but declares no rates, so it must carry `gpt`'s.
    const gpt5 = findModelProfile('gpt-5');
    expect(gpt5.tier).toBe('reasoning');                 // entry override
    expect(gpt5.inputCostPerMTok).toBe(2.5);             // inherited from `gpt`
    expect(gpt5.outputCostPerMTok).toBe(15);
    expect(gpt5.inputTokenSoftLimit).toBe(1_000_000);    // entry override, not the provider default
  });

  it('falls back to the provider default for a field neither entry nor parent sets', () => {
    // The mistral group's defaults declare supportsEffort: false; no mistral entry overrides it.
    expect(findModelProfile('mistral-medium').supportsEffort).toBe(false);
    // The anthropic group's default is the opposite, which is what makes this a real check.
    expect(findModelProfile('claude-haiku-4-5').supportsEffort).toBe(true);
  });

  it('keeps an entry family override, which the parent must not overwrite', () => {
    // `codestral` sets `family: mistral` explicitly and has no prefix-parent, so this asserts the
    // entry layer reaches the result at all — the write that the redundant middle assignment made
    // look load-bearing.
    expect(findModelProfile('codestral-latest').family).toBe('mistral');
  });

  it('gives the longest matching prefix, not the first', () => {
    // `claude-haiku-4-5` matches both `claude` and `claude-haiku`; the more specific must win, or
    // every Haiku run would be billed at Sonnet rates.
    expect(findModelProfile('claude-haiku-4-5').prefix).toBe('claude-haiku');
    expect(findModelProfile('claude-haiku-4-5').inputCostPerMTok).not.toBe(
      findModelProfile('claude-3-7').inputCostPerMTok,
    );
  });
});
