import { describe, it, expect, vi } from 'vitest';
import { TaskRegistry } from '../../packages/core/src/unified/task-registry.js';

describe('TaskRegistry TTL eviction (server.limits.batchTtlMs)', () => {
  it('evicts terminal entries older than ttlMs on register; keeps in-flight + recent', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const reg = new TaskRegistry({ ttlMs: 1000 });
      reg.register('old', '/c', 'delegate');
      reg.complete('old', { ok: true });          // terminalAt = 0
      reg.register('inflight', '/c', 'delegate');  // pending, terminalAt = null

      vi.setSystemTime(2000);                       // 2000 - 0 > 1000 for 'old'
      reg.register('fresh', '/c', 'delegate');      // register triggers the sweep

      expect(reg.get('old')).toBeUndefined();       // terminal + expired → evicted
      expect(reg.get('inflight')).toBeDefined();    // in-flight is NEVER evicted, any age
      expect(reg.get('fresh')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a terminal entry still within ttlMs (caller can still poll its result)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const reg = new TaskRegistry({ ttlMs: 10_000 });
      reg.register('recent', '/c', 'delegate');
      reg.complete('recent', { ok: true });         // terminalAt = 0
      vi.setSystemTime(5000);                        // 5000 - 0 < 10000
      reg.register('next', '/c', 'delegate');
      expect(reg.get('recent')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TaskRegistry', () => {
  it('registers a task as pending', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/cwd', 'delegate');
    const e = reg.get('t1');
    expect(e).toBeDefined();
    expect(e!.state).toBe('pending');
    expect(reg.isTerminal('t1')).toBe(false);
  });

  it('completes a task', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/cwd', 'delegate');
    reg.complete('t1', { status: 'done' });
    expect(reg.isTerminal('t1')).toBe(true);
    expect(reg.get('t1')!.result).toEqual({ status: 'done' });
  });

  it('fails a task', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/cwd', 'delegate');
    reg.fail('t1', { error: 'boom' });
    expect(reg.isTerminal('t1')).toBe(true);
  });

  it('returns undefined for unknown task', () => {
    expect(new TaskRegistry().get('nope')).toBeUndefined();
  });

  it('updates running headline', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/cwd', 'delegate');
    reg.setHeadline('t1', 'Phase 1...');
    expect(reg.get('t1')!.runningHeadline).toBe('Phase 1...');
  });

  it('does not update headline on terminal task', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/cwd', 'delegate');
    reg.complete('t1', {});
    reg.setHeadline('t1', 'should not set');
    expect(reg.get('t1')!.runningHeadline).toBeNull();
  });

  it('counts active tasks per cwd', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.register('t2', '/a', 'audit');
    reg.register('t3', '/b', 'delegate');
    expect(reg.countActive('/a')).toBe(2);
    reg.complete('t1', {});
    expect(reg.countActive('/a')).toBe(1);
  });

  it('allInFlight returns only pending tasks', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.register('t2', '/a', 'audit');
    reg.complete('t1', {});
    const inflight = reg.allInFlight();
    expect(inflight).toHaveLength(1);
    expect(inflight[0].taskId).toBe('t2');
  });

  it('idempotent complete', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.complete('t1', { first: true });
    reg.complete('t1', { second: true });
    expect(reg.get('t1')!.result).toEqual({ first: true });
  });

  it('initializes phase fields as null', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    const e = reg.get('t1')!;
    expect(e.phase).toBeNull();
    expect(e.phaseStartedAt).toBeNull();
    expect(e.totalTasks).toBeNull();
  });

  it('setPhase updates phase and phaseStartedAt', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.setPhase('t1', 'implementing');
    const e = reg.get('t1')!;
    expect(e.phase).toBe('implementing');
    expect(e.phaseStartedAt).toBeTypeOf('number');
  });

  it('setPhase transitions from implementing to reviewing', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.setPhase('t1', 'implementing');
    reg.setPhase('t1', 'reviewing');
    expect(reg.get('t1')!.phase).toBe('reviewing');
  });

  it('setPhase does not update terminal tasks', () => {
    const reg = new TaskRegistry();
    reg.register('t1', '/a', 'delegate');
    reg.complete('t1', {});
    reg.setPhase('t1', 'implementing');
    expect(reg.get('t1')!.phase).toBeNull();
  });
});
