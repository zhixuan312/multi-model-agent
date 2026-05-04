import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '../packages/core/src/batch-registry.js';

describe('BatchRegistry', () => {
  describe('terminal-block mapping', () => {
    it('records and reads per-task terminal blockId', () => {
      const reg = new BatchRegistry();
      reg.register({
        batchId: 'b1',
        projectCwd: '/tmp',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });
      reg.recordTerminalBlock('b1', 0, 'block-aaa');
      reg.recordTerminalBlock('b1', 2, 'block-ccc');
      expect(reg.getTerminalBlock('b1', 0)).toBe('block-aaa');
      expect(reg.getTerminalBlock('b1', 1)).toBeUndefined();
      expect(reg.getTerminalBlock('b1', 2)).toBe('block-ccc');
    });

    it('throws on unknown batchId', () => {
      const reg = new BatchRegistry();
      expect(() => reg.recordTerminalBlock('nope', 0, 'x')).toThrow(/unknown batchId/);
    });

    it('returns undefined for unknown batchId on get', () => {
      const reg = new BatchRegistry();
      expect(reg.getTerminalBlock('nope', 0)).toBeUndefined();
    });
  });
});
