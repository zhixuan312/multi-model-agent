import { describe, expect, it } from 'vitest';
import {
  findModelProfile,
  modelProfileSchema,
  ModelFamilyEnum,
  type ModelFamily,
} from '../../packages/core/src/config/model-profile-registry.js';

/**
 * Derived from the enum, not retyped from it.
 *
 * A hand-written 33-name copy stood here under the claim "every known model family". A family
 * added to `ModelFamilyEnum` would not appear in it, so the loop would keep passing while
 * covering one family fewer than it said — and the way to notice was to count two lists by eye.
 * `Record<ModelFamily, string>` now fails `tsc -p tsconfig.tests.json` until the new family has
 * an example id, which is the one thing a test cannot derive: what a model of that family is
 * actually called.
 */
const MODEL_FAMILIES = ModelFamilyEnum.options;

const FAMILY_EXAMPLES: Record<ModelFamily, string> = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
  deepseek: 'deepseek-v4-pro',
  llama: 'llama-4',
  mistral: 'mistral-large',
  qwen: 'qwen3.5',
  grok: 'grok-4',
  cohere: 'command-r-plus',
  phi: 'phi-4',
  gemma: 'gemma-3',
  yi: 'yi-large',
  kimi: 'kimi-k2',
  sonar: 'sonar-pro',
  nova: 'nova-pro',
  glm: 'glm-5',
  minimax: 'MiniMax-M2',
  jamba: 'jamba-large',
  granite: 'granite-3.3',
  nemotron: 'nemotron-4',
  dbrx: 'dbrx-instruct',
  arctic: 'arctic-instruct',
  reka: 'reka-flash',
  olmo: 'olmo-2',
  hermes: 'hermes-3',
  wizardlm: 'wizardlm-2',
  starcoder: 'starcoder2',
  dolphin: 'dolphin-2.9',
  openchat: 'openchat-3.5',
  vicuna: 'vicuna-13b',
  internlm: 'internlm2.5',
  baichuan: 'baichuan2',
  other: 'custom',
};

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prefix: 'test-model',
    family: 'other',
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'tests',
    supportsEffort: false,
    inputTokenSoftLimit: 100_000,
    capabilities: [],
    ...overrides,
  };
}

describe('model profile registry', () => {
  it('resolves every known model family to a profile with the matching family field', () => {
    for (const family of MODEL_FAMILIES) {
      expect(findModelProfile(FAMILY_EXAMPLES[family]).family).toBe(family);
    }
  });

  it('validates cached and reasoning pricing as non-negative numbers', () => {
    expect(modelProfileSchema.safeParse(baseProfile({ cachedReadCostPerMTok: 0 })).success).toBe(true);
    expect(modelProfileSchema.safeParse(baseProfile({ reasoningCostPerMTok: 0 })).success).toBe(true);

    expect(modelProfileSchema.safeParse(baseProfile({ cachedReadCostPerMTok: -0.01 })).success).toBe(false);
    expect(modelProfileSchema.safeParse(baseProfile({ reasoningCostPerMTok: -0.01 })).success).toBe(false);
  });
});
