import { describe, expect, it } from 'vitest';
import {
  ALL_MODEL_IDS,
  findModelProfile,
  modelProfileSchema,
} from '../../packages/core/src/routing/model-profiles.js';

const MODEL_FAMILIES = [
  'claude',
  'openai',
  'gemini',
  'deepseek',
  'llama',
  'mistral',
  'qwen',
  'grok',
  'cohere',
  'phi',
  'gemma',
  'yi',
  'kimi',
  'sonar',
  'nova',
  'glm',
  'minimax',
  'jamba',
  'granite',
  'nemotron',
  'dbrx',
  'arctic',
  'reka',
  'olmo',
  'hermes',
  'wizardlm',
  'starcoder',
  'dolphin',
  'openchat',
  'vicuna',
  'internlm',
  'baichuan',
  'other',
] as const;

const FAMILY_EXAMPLES: Record<(typeof MODEL_FAMILIES)[number], string> = {
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
  it('has at least one profile for every V3 model family', () => {
    for (const family of MODEL_FAMILIES) {
      expect(findModelProfile(FAMILY_EXAMPLES[family]).family).toBe(family);
    }
  });

  it('every exported profile has a family field', () => {
    for (const modelId of ALL_MODEL_IDS) {
      expect(findModelProfile(modelId).family).toBeDefined();
    }
  });

  it('validates cached and reasoning pricing as non-negative numbers', () => {
    expect(modelProfileSchema.safeParse(baseProfile({ cachedInputCostPerMTok: 0 })).success).toBe(true);
    expect(modelProfileSchema.safeParse(baseProfile({ reasoningCostPerMTok: 0 })).success).toBe(true);

    expect(modelProfileSchema.safeParse(baseProfile({ cachedInputCostPerMTok: -0.01 })).success).toBe(false);
    expect(modelProfileSchema.safeParse(baseProfile({ reasoningCostPerMTok: -0.01 })).success).toBe(false);
  });
});
