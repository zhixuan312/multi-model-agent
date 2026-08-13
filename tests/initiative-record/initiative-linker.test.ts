import { describe, expect, it } from 'vitest';
import { terminalTaskUpdate } from '../../packages/server/src/application/initiative-linker.js';

describe('InitiativeLinker terminal mapping', () => {
  it.each([
    ['completed', { transition: 'completed', outcome: 'succeeded' }],
    ['done_with_concerns', { transition: 'completed', outcome: 'succeeded_with_concerns' }],
    ['failed', { transition: 'blocked', outcome: undefined }],
    ['cancelled', { transition: 'open', outcome: undefined }],
    ['interrupted', { transition: 'open', outcome: undefined }],
  ] as const)('maps %s without a failed Task terminal state', (status, expected) => {
    expect(terminalTaskUpdate(status)).toEqual(expected);
  });
});