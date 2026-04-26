import { describe, it, expect } from 'vitest';
import { isRateLimit, classifyError } from '../../packages/core/src/runners/error-classification.js';

describe('isRateLimit', () => {
  it('returns true for errors with status 429', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    expect(isRateLimit(err)).toBe(true);
  });

  it('returns true for errors with code rate_limit_exceeded', () => {
    const err = Object.assign(new Error('rate limit hit'), { code: 'rate_limit_exceeded' });
    expect(isRateLimit(err)).toBe(true);
  });

  it('returns true for errors whose message mentions rate limit', () => {
    expect(isRateLimit(new Error('rate limit exceeded, try again'))).toBe(true);
    expect(isRateLimit(new Error('Rate limited by provider'))).toBe(true);
    expect(isRateLimit(new Error('You hit a RATE_LIMIT'))).toBe(true);
  });

  it('returns false for errors with other HTTP statuses', () => {
    expect(isRateLimit(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe(false);
    expect(isRateLimit(Object.assign(new Error('Server Error'), { status: 500 }))).toBe(false);
    expect(isRateLimit(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRateLimit(new Error('something broke'))).toBe(false);
    expect(isRateLimit(null)).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
    expect(isRateLimit('string error')).toBe(false);
  });
});

describe('Runner surfaces structured rate_limit_exceeded code', () => {
  it('classifyError classifies a 429 as api_error (preserving existing behavior)', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const { status, reason } = classifyError(err);
    // 429 still classifies as api_error — isRateLimit is a separate orthogonal check
    expect(status).toBe('api_error');
    expect(reason).toContain('HTTP 429');
  });

  it('isRateLimit can be used alongside classifyError to surface structuredError', () => {
    // This mirrors the pattern used in every runner's catch block:
    //   const { status, reason } = classifyError(err);
    //   ...(isRateLimit(err) && { structuredError: { code: 'rate_limit_exceeded', ... } })
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const classified = classifyError(err);
    const rateLimited = isRateLimit(err);

    expect(classified.status).toBe('api_error');
    expect(rateLimited).toBe(true);
  });
});
