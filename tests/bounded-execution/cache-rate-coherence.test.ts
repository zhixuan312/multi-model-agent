/**
 * Cache rates are a MULTIPLE of input, so every model's must stay coherent with its own input.
 *
 * Inheritance copied the parent's ABSOLUTE cache rates onto children that re-priced `input`.
 * `claude-3-opus` (input 15) inherited the `claude` parent's 0.3 — a 0.02x ratio where the family
 * charges 0.10x, six-fold under-billing on every cached read. `claude-3-haiku` (input 0.25)
 * inherited the same 0.3 and priced a CACHE READ at 1.2x FRESH INPUT, which no provider charges
 * and which is the tell that this was a defect rather than a pricing decision. Seven live models
 * were affected, in both directions (gpt-5.4-pro 12x under, glm-4 3.3x over).
 *
 * It also disabled the protective `input * 0.10` fallback in `cost-compute.ts`, which fires only
 * when the field is undefined: the inherited absolute value made it defined, and wrong, exactly
 * where the fallback was needed.
 *
 * These assertions are properties of the catalog, not a list of expected numbers — a restated
 * table would need editing every time a rate moves, and would not have caught the original bug
 * because the numbers it restated came from the same broken resolution.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveRateCard } from '../../packages/core/src/bounded-execution/cost-compute.js';

/** Every model prefix the catalog declares, parents and children alike. */
function catalogPrefixes(): string[] {
  const raw = JSON.parse(
    readFileSync('packages/core/src/model-profiles.json', 'utf8'),
  ) as Array<{ profiles?: Array<{ prefix: string }> }>;
  return raw.flatMap((group) => (group.profiles ?? []).map((m) => m.prefix));
}

const PREFIXES = catalogPrefixes();

/**
 * Prefixes that state their own `cachedRead`. Their ratio is a deliberate published figure and is
 * NOT second-guessed here: DeepSeek prices a cache read at 0.008x input, far under the ~0.10x that
 * Anthropic and OpenAI charge. The band below exists to catch a rate INHERITED from a
 * differently-priced parent, so applying it to a declared rate would just encode one vendor's
 * pricing as a universal law — and would have to be widened every time a vendor undercuts it.
 */
const DECLARES_OWN_CACHE_READ = new Set(
  (JSON.parse(readFileSync('packages/core/src/model-profiles.json', 'utf8')) as Array<{
    profiles?: Array<{ prefix: string; cachedRead?: number }>;
  }>)
    .flatMap((g) => g.profiles ?? [])
    .filter((p) => p.cachedRead !== undefined)
    .map((p) => p.prefix),
);

describe('cache rates stay coherent with input', () => {
  it('finds the catalog', () => {
    // Floor: an empty list would make every case below vacuous.
    expect(PREFIXES.length).toBeGreaterThan(20);
  });

  /**
   * The floor above counts what is ITERATED; this counts what is ASSERTED.
   *
   * Every case below opens with `if (!card) return`, which is correct — open-weight entries publish
   * no rates and a bare family stem is not a model anyone names — but it means a regression in
   * `resolveRateCard` that returned null for EVERYTHING would send all 102 cases down the early
   * return, three suites would report green, and not one rate would have been compared. The
   * roster floor cannot see that: the roster is read straight from JSON and stays full either way.
   *
   * 83 of 102 resolve today. The bound is deliberately well below that, so ordinary catalog
   * churn does not trip it while a collapse still does.
   */
  it('most prefixes resolve to a real card, so the cases below are not all early returns', () => {
    const resolved = PREFIXES.filter((p) => resolveRateCard(p) != null);
    expect(
      resolved.length,
      'rate resolution collapsed — every case below is returning before it asserts anything',
    ).toBeGreaterThan(60);
  });

  it.each(PREFIXES)('%s never prices a cache read above fresh input', (prefix) => {
    const card = resolveRateCard(prefix);
    // A null card is a legitimate state, not a defect: open-weight entries (phi, gemma, yi)
    // publish no rates, and a bare family prefix like `meta-llama/` is a matching stem rather
    // than a model anyone names. Both mean "no rates known", which prices nothing.
    if (!card) return;
    // The physical claim: reading from cache is a discount. A provider charging MORE to read its
    // own cache than to process fresh tokens does not exist, so any such rate is a resolution bug.
    expect(
      card.cachedReadCostPerMTok,
      `${prefix}: cache read ${card.cachedReadCostPerMTok} exceeds input ${card.inputCostPerMTok}`,
    ).toBeLessThanOrEqual(card.inputCostPerMTok);
  });

  it.each(PREFIXES)('%s keeps an inherited cache-read discount in a plausible band', (prefix) => {
    if (DECLARES_OWN_CACHE_READ.has(prefix)) return;
    const card = resolveRateCard(prefix);
    if (!card) return;
    const ratio = card.cachedReadCostPerMTok / card.inputCostPerMTok;
    // Published rates cluster at 0.10x (Anthropic, OpenAI) and up to ~0.25x elsewhere. A ratio
    // outside this band means the number was inherited from a differently-priced parent rather
    // than chosen — the failure mode here — not that a provider invented a new discount.
    expect(ratio, `${prefix}: cache read is ${ratio.toFixed(3)}x input`).toBeGreaterThan(0.01);
    expect(ratio, `${prefix}: cache read is ${ratio.toFixed(3)}x input`).toBeLessThanOrEqual(0.30);
  });

  it.each(PREFIXES)('%s prices a cache write at or above input', (prefix) => {
    const card = resolveRateCard(prefix);
    if (!card) return;
    // The mirror claim: writing to cache is a premium (Anthropic 1.25x) or at parity, never a
    // discount. claude-3-opus inherited 3.75 against input 15 — a 0.25x write, i.e. cheaper than
    // not caching.
    expect(
      card.cachedNonReadCostPerMTok,
      `${prefix}: cache write ${card.cachedNonReadCostPerMTok} is below input ${card.inputCostPerMTok}`,
    ).toBeGreaterThanOrEqual(card.inputCostPerMTok);
  });

  it('an explicitly declared rate is never rescaled', () => {
    // glm-4.7 states cachedRead 0.11 while its parent's ratio would give 0.12. A deliberate figure
    // must survive inheritance untouched, or fixing the bug above would overwrite real data.
    expect(resolveRateCard('glm-4.7')?.cachedReadCostPerMTok).toBe(0.11);
  });
});
