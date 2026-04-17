import { describe, it, expect } from 'vitest';
import { validateSource, isValidSource } from '../../packages/core/src/intake/source-schema.js';
import type { AnySource } from '../../packages/core/src/intake/types.js';

describe('source-schema', () => {
  describe('validateSource', () => {
    it('accepts valid delegate_tasks source', () => {
      const source: AnySource = { route: 'delegate_tasks', originalInput: { prompt: 'hello' } };
      expect(() => validateSource(source)).not.toThrow();
    });

    it('accepts valid review_code source', () => {
      const source: AnySource = { route: 'review_code', originalInput: {}, code: 'const x = 1;' };
      expect(() => validateSource(source)).not.toThrow();
    });

    it('accepts valid debug_task source', () => {
      const source: AnySource = { route: 'debug_task', originalInput: {}, problem: 'bug', context: 'ctx' };
      expect(() => validateSource(source)).not.toThrow();
    });

    it('accepts valid verify_work source', () => {
      const source: AnySource = { route: 'verify_work', originalInput: {}, checklist: ['check something'] };
      expect(() => validateSource(source)).not.toThrow();
    });

    it('accepts valid audit_document source', () => {
      const source: AnySource = { route: 'audit_document', originalInput: {}, auditType: 'security' };
      expect(() => validateSource(source)).not.toThrow();
    });

    it('rejects invalid route', () => {
      expect(() => validateSource({ route: 'invalid', originalInput: {} })).toThrow();
    });

    it('rejects missing originalInput', () => {
      expect(() => validateSource({ route: 'delegate_tasks' })).toThrow();
    });
  });

  describe('isValidSource', () => {
    it('returns true for valid source', () => {
      expect(isValidSource({ route: 'delegate_tasks', originalInput: {} })).toBe(true);
    });

    it('returns false for invalid source', () => {
      expect(isValidSource({ route: 'invalid', originalInput: {} })).toBe(false);
      expect(isValidSource({})).toBe(false);
      expect(isValidSource(null)).toBe(false);
    });
  });
});