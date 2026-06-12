import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../packages/server/src/http/project-registry.js';
import { TaskRegistry } from '@zhixuan92/multi-model-agent-core';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eviction-'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('project eviction', () => {
  it('project with taskRegistry.countActive(cwd) > 0 is NOT evicted past idle timeout', () => {
    vi.useFakeTimers();
    const idleTimeoutMs = 5_000;
    const registry = new ProjectRegistry({ cap: 10, idleEvictionMs: idleTimeoutMs, evictionIntervalMs: 60_000 });
    const taskRegistry = new TaskRegistry();

    const dir = tmpDir();
    const r = registry.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.projectContext;

    // Cancel the reservation so activeRequests/pendingReservations are zero
    registry.cancelReservation(pc.cwd);

    // Register a non-terminal task for this cwd
    taskRegistry.register('task-1', pc.cwd, 'delegate');

    // Advance time past idle threshold
    vi.setSystemTime(Date.now() + idleTimeoutMs + 1_000);
    // Manually backdate lastActivityAt to be past the threshold
    pc.lastActivityAt = Date.now() - idleTimeoutMs - 2_000;

    // Evict with taskRegistry — project should NOT be evicted because task is active
    registry.evictIdle(taskRegistry);
    expect(registry.size).toBe(1);
    expect(registry.get(pc.cwd)).toBeDefined();
  });

  it('project with activeRequests === 0 AND no active tasks past idle IS evicted', () => {
    vi.useFakeTimers();
    const idleTimeoutMs = 5_000;
    const registry = new ProjectRegistry({ cap: 10, idleEvictionMs: idleTimeoutMs, evictionIntervalMs: 60_000 });
    const taskRegistry = new TaskRegistry();

    const dir = tmpDir();
    const r = registry.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.projectContext;

    // Cancel the reservation so pendingReservations drops to zero
    registry.cancelReservation(pc.cwd);

    // No tasks registered — countActive returns 0

    // Backdate lastActivityAt past idle threshold
    pc.lastActivityAt = Date.now() - idleTimeoutMs - 1_000;

    registry.evictIdle(taskRegistry);
    expect(registry.size).toBe(0);
    expect(registry.get(pc.cwd)).toBeUndefined();
  });
});
