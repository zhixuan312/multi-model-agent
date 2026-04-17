import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMaxRoundsPerDraft } from '../../packages/core/src/intake/feature-flag.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const BASE_CONFIG: MultiModelConfig = {
  agents: { standard: { type: 'openai-compatible', model: 'std', baseUrl: 'http://localhost' }, complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'http://localhost' } },
  defaults: { timeoutMs: 600_000, tools: 'full', sandboxPolicy: 'cwd-only' },
};

describe('feature-flag', () => {
  const savedRounds = process.env['MULTI_MODEL_CLARIFICATIONS_MAX_ROUNDS'];

  beforeEach(() => {
    delete process.env['MULTI_MODEL_CLARIFICATIONS_MAX_ROUNDS'];
  });

  afterEach(() => {
    if (savedRounds !== undefined) process.env['MULTI_MODEL_CLARIFICATIONS_MAX_ROUNDS'] = savedRounds;
    else delete process.env['MULTI_MODEL_CLARIFICATIONS_MAX_ROUNDS'];
  });

  describe('getMaxRoundsPerDraft', () => {
    it('defaults to 3 when no config or env', () => {
      expect(getMaxRoundsPerDraft(BASE_CONFIG)).toBe(3);
    });

    it('returns config value when set', () => {
      expect(getMaxRoundsPerDraft({ ...BASE_CONFIG, clarifications: { maxRoundsPerDraft: 7 } })).toBe(7);
    });
  });
});
