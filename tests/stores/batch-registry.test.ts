import { describe, it, expect, vi } from 'vitest';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

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

  describe('two-step retention', () => {
    it('time-window prune removes expired and stale terminal entries', () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const reg = new BatchRegistry({ batchTtlMs: 1000, max: 10 });
      reg.register({
        batchId: 'b1',
        projectCwd: '/tmp',
        tool: 'delegate',
        state: 'pending',
        startedAt: t0,
        stateChangedAt: t0,
        blockIds: [],
        blocksReleased: false,
      });
      reg.complete('b1', { ok: true });
      vi.setSystemTime(t0 + 2000);
      reg.prune();
      expect(reg.get('b1')).toBeUndefined();
      vi.useRealTimers();
    });

    it('LRU prune fires after time-window leaves >max', () => {
      const reg = new BatchRegistry({ max: 200 });
      for (let i = 0; i < 250; i++) {
        reg.register({
          batchId: `b${i}`,
          projectCwd: '/tmp',
          tool: 'delegate',
          state: 'pending',
          startedAt: Date.now(),
          stateChangedAt: Date.now(),
          blockIds: [],
          blocksReleased: false,
        });
      }
      reg.prune();
      expect(reg.size()).toBe(200);
      expect(reg.get('b0')).toBeUndefined();
      expect(reg.get('b49')).toBeUndefined();
      expect(reg.get('b50')).toBeDefined();
    });

    it('LRU eviction releases pinned context blocks for non-terminal entries', () => {
      const pinned: string[] = [];
      const unpinned: string[] = [];
      const store = {
        pin(id: string) { pinned.push(id); },
        unpin(id: string) { unpinned.push(id); },
      };
      const reg = new BatchRegistry({ max: 3 }, { contextBlockStore: store });
      for (let i = 0; i < 5; i++) {
        reg.register({
          batchId: `b${i}`,
          projectCwd: '/tmp',
          tool: 'delegate',
          state: 'pending',
          startedAt: Date.now(),
          stateChangedAt: Date.now(),
          blockIds: [`block-${i}`],
          blocksReleased: false,
        });
      }
      expect(pinned).toHaveLength(5);
      reg.prune();
      expect(reg.size()).toBe(3);
      // b0 and b1 were LRU-evicted — their blocks must be unpinned
      expect(unpinned).toContain('block-0');
      expect(unpinned).toContain('block-1');
      // b2, b3, b4 survive
      expect(unpinned).not.toContain('block-2');
      expect(unpinned).not.toContain('block-3');
      expect(unpinned).not.toContain('block-4');
    });

    it('non-terminal entries are not time-window pruned', () => {
      const reg = new BatchRegistry({ batchTtlMs: 1000, max: 10 });
      reg.register({
        batchId: 'b1',
        projectCwd: '/tmp',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now() - 5000,
        stateChangedAt: Date.now() - 5000,
        blockIds: [],
        blocksReleased: false,
      });
      reg.prune();
      expect(reg.get('b1')).toBeDefined();
      expect(reg.get('b1')!.state).toBe('pending');
    });
  });
});
