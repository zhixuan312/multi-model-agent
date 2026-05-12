import { describe, it, expect } from 'vitest';
import { ProviderTypeEnum } from '../../packages/core/src/types/enums.js';

describe('ProviderTypeEnum', () => {
  it('contains the v4.4 canonical two-value vocabulary', () => {
    expect(ProviderTypeEnum.options).toEqual(['claude', 'codex']);
  });

  it("accepts 'claude' as a valid value", () => {
    expect(ProviderTypeEnum.safeParse('claude').success).toBe(true);
  });

  it("accepts 'codex' as a valid value", () => {
    expect(ProviderTypeEnum.safeParse('codex').success).toBe(true);
  });

  it('rejects unknown protocols', () => {
    expect(ProviderTypeEnum.safeParse('anthropic-direct').success).toBe(false);
  });

  it('rejects the removed legacy values', () => {
    expect(ProviderTypeEnum.safeParse('openai-compatible').success).toBe(false);
    expect(ProviderTypeEnum.safeParse('claude-compatible').success).toBe(false);
    expect(ProviderTypeEnum.safeParse('openai').success).toBe(false);
  });
});
