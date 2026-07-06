import { describe, it, expect } from 'vitest';
import {
  TASK_TYPES, TYPE_REGISTRY, getTypeConfig, oppositeAgent,
  type TaskType,
} from '../../packages/core/src/unified/type-registry.js';

describe('TypeRegistry', () => {
  it('has 13 task types', () => {
    expect(TASK_TYPES).toHaveLength(13);
  });

  it('delegate defaults to standard/worktree/cwd-only', () => {
    const c = getTypeConfig('delegate');
    expect(c).toMatchObject({ defaultTier: 'standard', worktree: true, sandbox: 'cwd-only' });
  });

  it('audit defaults to complex/no-worktree/read-only', () => {
    const c = getTypeConfig('audit');
    expect(c).toMatchObject({ defaultTier: 'complex', worktree: false, sandbox: 'read-only' });
  });

  it('journal_record defaults to complex/no-worktree/cwd-only', () => {
    const c = getTypeConfig('journal_record');
    expect(c).toMatchObject({ defaultTier: 'complex', worktree: false, sandbox: 'cwd-only' });
  });

  it('orchestrate defaults to main/no-worktree/cwd-only', () => {
    const c = getTypeConfig('orchestrate');
    expect(c).toMatchObject({ defaultTier: 'main', worktree: false, sandbox: 'cwd-only' });
  });

  it('throws for unknown type', () => {
    expect(() => getTypeConfig('bogus' as TaskType)).toThrow('Unknown task type');
  });

  it('oppositeAgent inverts standard/complex and maps main to complex', () => {
    expect(oppositeAgent('standard')).toBe('complex');
    expect(oppositeAgent('complex')).toBe('standard');
    expect(oppositeAgent('main')).toBe('complex');
  });

  it('every registered type has complete config including targetAcceptance', () => {
    for (const t of TASK_TYPES) {
      const c = getTypeConfig(t);
      expect(['standard', 'complex', 'main']).toContain(c.defaultTier);
      expect(typeof c.worktree).toBe('boolean');
      expect(['read-only', 'cwd-only']).toContain(c.sandbox);
      expect(typeof c.targetAcceptance.paths).toBe('boolean');
      expect(typeof c.targetAcceptance.inline).toBe('boolean');
      expect(typeof c.targetAcceptance.required).toBe('boolean');
    }
  });

  it('targetAcceptance: read routes with targets accept paths', () => {
    for (const t of ['audit', 'investigate', 'review', 'debug'] as const) {
      expect(getTypeConfig(t).targetAcceptance.paths).toBe(true);
    }
  });

  it('targetAcceptance: target required for audit and review, optional for investigate and debug', () => {
    expect(getTypeConfig('audit').targetAcceptance.required).toBe(true);
    expect(getTypeConfig('review').targetAcceptance.required).toBe(true);
    expect(getTypeConfig('investigate').targetAcceptance.required).toBe(false);
    expect(getTypeConfig('debug').targetAcceptance.required).toBe(false);
  });

  it('targetAcceptance: routes without targets reject all', () => {
    for (const t of ['research', 'journal_recall', 'journal_record', 'retry_tasks', 'orchestrate'] as const) {
      expect(getTypeConfig(t).targetAcceptance.paths).toBe(false);
      expect(getTypeConfig(t).targetAcceptance.inline).toBe(false);
      expect(getTypeConfig(t).targetAcceptance.required).toBe(false);
    }
  });

  it('targetAcceptance: only audit, review, spec, and plan accept inline', () => {
    expect(getTypeConfig('audit').targetAcceptance.inline).toBe(true);
    expect(getTypeConfig('review').targetAcceptance.inline).toBe(true);
    expect(getTypeConfig('spec').targetAcceptance.inline).toBe(true);
    expect(getTypeConfig('plan').targetAcceptance.inline).toBe(true);
    expect(getTypeConfig('investigate').targetAcceptance.inline).toBe(false);
    expect(getTypeConfig('debug').targetAcceptance.inline).toBe(false);
  });

  it('spec defaults to complex/worktree/cwd-only with required target', () => {
    const c = getTypeConfig('spec');
    expect(c).toMatchObject({ defaultTier: 'complex', worktree: true, sandbox: 'cwd-only' });
    expect(c.targetAcceptance).toEqual({ paths: true, inline: true, required: true });
  });

  it('plan defaults to complex/worktree/cwd-only with required target', () => {
    const c = getTypeConfig('plan');
    expect(c).toMatchObject({ defaultTier: 'complex', worktree: true, sandbox: 'cwd-only' });
    expect(c.targetAcceptance).toEqual({ paths: true, inline: true, required: true });
  });
});
