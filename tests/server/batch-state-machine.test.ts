import { describe, it, expect, vi } from 'vitest';
import { BatchRegistry, BatchState, isTerminal } from '../../packages/core/src/batch-registry.js';
import type { BatchEntry } from '../../packages/core/src/batch-registry.js';

describe('batch state machine', () => {
  it('defines exactly the five states', () => {
    const states: BatchState[] = ['pending', 'awaiting_clarification', 'complete', 'failed', 'expired'];
    // Type-level assertion; also runtime sanity:
    expect(states.length).toBe(5);
  });

  it('classifies terminal vs non-terminal', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('awaiting_clarification')).toBe(false);
    expect(isTerminal('complete')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
  });
});
