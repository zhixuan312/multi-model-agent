import { describe, it, expect } from 'vitest';
import { retryableFor, classifyContextBlockError } from '@zhixuan92/multi-model-agent-core/error-codes';

describe('retryableFor', () => {
  it('returns true for timeout', () => {
    expect(retryableFor('timeout')).toBe(true);
  });
  it('returns true for network_error', () => {
    expect(retryableFor('network_error')).toBe(true);
  });
  it('returns true for api_error', () => {
    expect(retryableFor('api_error')).toBe(true);
  });
  it('returns false for ok', () => {
    expect(retryableFor('ok')).toBe(false);
  });
  it('returns false for error', () => {
    expect(retryableFor('error')).toBe(false);
  });
});

describe('classifyContextBlockError', () => {
  it('returns context_block_not_found for missing block', () => {
    expect(classifyContextBlockError(new Error('context block "xyz" not found'))).toBe('context_block_not_found');
  });
  it('returns context_block_not_found for undefined id', () => {
    expect(classifyContextBlockError(new Error('id is undefined'))).toBe('context_block_not_found');
  });
  it('returns retryable for rate limit', () => {
    expect(classifyContextBlockError(new Error('rate limit exceeded'))).toBe('retryable');
  });
  it('returns non_retryable for other errors', () => {
    expect(classifyContextBlockError(new Error('something else'))).toBe('non_retryable');
  });
});
