import { describe, it, expect } from 'vitest';
import {
  TASK_TYPES, TYPE_REGISTRY, getTypeConfig, oppositeAgent,
  type TaskType,
} from '../../packages/core/src/unified/type-registry.js';

describe('TypeRegistry', () => {
  it('has 10 task types', () => {
    expect(TASK_TYPES).toHaveLength(10);
  });

  it('delegate defaults to standard/worktree/cwd-only', () => {
    const c = getTypeConfig('delegate');
    expect(c).toEqual({ defaultTier: 'standard', worktree: true, sandbox: 'cwd-only' });
  });

  it('audit defaults to complex/no-worktree/read-only', () => {
    const c = getTypeConfig('audit');
    expect(c).toEqual({ defaultTier: 'complex', worktree: false, sandbox: 'read-only' });
  });

  it('journal_record defaults to complex/no-worktree/cwd-only', () => {
    const c = getTypeConfig('journal_record');
    expect(c).toEqual({ defaultTier: 'complex', worktree: false, sandbox: 'cwd-only' });
  });

  it('throws for unknown type', () => {
    expect(() => getTypeConfig('bogus' as TaskType)).toThrow('Unknown task type');
  });

  it('oppositeAgent inverts', () => {
    expect(oppositeAgent('standard')).toBe('complex');
    expect(oppositeAgent('complex')).toBe('standard');
  });

  it('every registered type has complete config', () => {
    for (const t of TASK_TYPES) {
      const c = getTypeConfig(t);
      expect(['standard', 'complex']).toContain(c.defaultTier);
      expect(typeof c.worktree).toBe('boolean');
      expect(['read-only', 'cwd-only']).toContain(c.sandbox);
    }
  });
});
