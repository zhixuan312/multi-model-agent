import { describe, it, expect } from 'bun:test';
import type { TurnResult } from '../../packages/core/src/types/run-result.js';

const NINE_KEYS: ReadonlyArray<keyof TurnResult | 'errorCode'> = [
  'output',
  'usage',
  'costUSD',
  'turns',
  'durationMs',
  'terminationReason',
  'errorCode',
  'filesWritten',
  'usedShell',
];

describe('TurnResult shape (A4.2)', () => {
  it('the only allowed top-level keys are the 9 spec-listed fields', () => {
    const allowed = new Set<string>(NINE_KEYS as string[]);
    const sample: TurnResult = {
      output: '',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      costUSD: 0,
      turns: 0,
      durationMs: 0,
      terminationReason: 'ok',
      filesWritten: [],
      usedShell: false,
    };
    for (const k of Object.keys(sample)) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});
