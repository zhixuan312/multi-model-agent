import { describe, it, expect } from 'vitest';
import { ProviderTypeEnum } from '../../packages/core/src/types/enums.js';

describe('ProviderTypeEnum', () => {
  it('matches the 5 canonical values defined in enums.md §1', () => {
    expect(ProviderTypeEnum.options).toEqual([
      'claude',
      'claude-compatible',
      'openai',
      'openai-compatible',
      'codex',
    ]);
  });

  it("accepts 'openai' as a valid value", () => {
    expect(ProviderTypeEnum.safeParse('openai').success).toBe(true);
  });

  it('rejects unknown protocols', () => {
    expect(ProviderTypeEnum.safeParse('anthropic-direct').success).toBe(false);
  });
});
