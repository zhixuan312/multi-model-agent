import { describe, it, expect } from 'bun:test';
import { retryableFor } from '@zhixuan92/multi-model-agent-core/error-codes';

describe('retryableFor', () => {
  it('returns true for provider_timeout', () => {
    expect(retryableFor('provider_timeout')).toBe(true);
  });
  it('returns false for ok', () => {
    expect(retryableFor('ok')).toBe(false);
  });
  it('returns false for error', () => {
    expect(retryableFor('error')).toBe(false);
  });
});
