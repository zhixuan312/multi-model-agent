import { describe, expect, it } from 'vitest';
import { findingsSchema, type Finding } from '../../packages/core/src/executors/_shared/findings-schema.js';

describe('findingsSchema', () => {
  it('accepts a fully-populated finding', () => {
    const result = findingsSchema.safeParse([
      {
        id: 'F1',
        severity: 'high',
        file: 'src/auth/login.ts',
        line: 89,
        claim: 'Missing null check on req.body.user',
        sourceQuote: '  const x = req.body.user.id;',
        suggestedFix: 'Wrap in optional chaining.',
      },
    ]);
    expect(result.success).toBe(true);
  });

  it('accepts a finding with file=null and line=null (project-level)', () => {
    const result = findingsSchema.safeParse([
      { id: 'F2', severity: 'medium', file: null, line: null, claim: 'Plan does not address authentication.' },
    ]);
    expect(result.success).toBe(true);
  });

  it('accepts a finding without optional fields (sourceQuote, suggestedFix)', () => {
    const result = findingsSchema.safeParse([
      { id: 'F3', severity: 'low', file: 'README.md', line: 12, claim: 'Typo in heading.' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects uppercase severity', () => {
    const result = findingsSchema.safeParse([
      { id: 'F4', severity: 'HIGH', file: 'a.ts', line: 1, claim: 'x' },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects line=0 (not 1-indexed)', () => {
    const result = findingsSchema.safeParse([
      { id: 'F5', severity: 'low', file: 'a.ts', line: 0, claim: 'x' },
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts an empty array', () => {
    const result = findingsSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it('rejects missing id, severity, or claim', () => {
    expect(findingsSchema.safeParse([{ severity: 'low', file: 'a', line: 1, claim: 'x' }]).success).toBe(false);
    expect(findingsSchema.safeParse([{ id: 'F1', file: 'a', line: 1, claim: 'x' }]).success).toBe(false);
    expect(findingsSchema.safeParse([{ id: 'F1', severity: 'low', file: 'a', line: 1 }]).success).toBe(false);
  });
});
