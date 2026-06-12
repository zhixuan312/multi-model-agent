import { describe, it, expect } from 'vitest';
import {
  getTypeConfig, oppositeAgent, taskInputSchema, parseReviewerOutput, TASK_TYPES,
} from '../../packages/core/src/index.js';

describe('Phase 1 Smoke', () => {
  it('type registry works for all types', () => {
    for (const t of TASK_TYPES) {
      expect(() => getTypeConfig(t)).not.toThrow();
    }
  });

  it('opposite agent inverts', () => {
    expect(oppositeAgent('standard')).toBe('complex');
    expect(oppositeAgent('complex')).toBe('standard');
  });

  it('schema validates delegate', () => {
    expect(taskInputSchema.safeParse({ type: 'delegate', tasks: [{ prompt: 'x' }] }).success).toBe(true);
  });

  it('schema validates audit', () => {
    expect(taskInputSchema.safeParse({ type: 'audit', filePaths: ['/x'] }).success).toBe(true);
  });

  it('schema rejects unknown type', () => {
    expect(taskInputSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('schema rejects legacy reviewPolicy', () => {
    expect(taskInputSchema.safeParse({ type: 'delegate', tasks: [{ prompt: 'x' }], reviewPolicy: 'full' }).success).toBe(false);
  });

  it('parser handles valid reviewer JSON', () => {
    expect(parseReviewerOutput('```json\n{"findings":[],"summary":"ok","verdict":"approved"}\n```').ok).toBe(true);
  });

  it('parser rejects prose', () => {
    expect(parseReviewerOutput('all good').ok).toBe(false);
  });
});
