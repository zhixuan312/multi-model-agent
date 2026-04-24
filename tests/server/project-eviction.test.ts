import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../packages/server/src/http/project-registry.js';
import { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eviction-'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('project eviction', () => {
  it('project with batchRegistry.countActiveForProject(cwd) > 0 is NOT evicted past idle timeout', () => {
    vi.useFakeTimers();
    const idleTimeoutMs = 5_000;
    const registry = new ProjectRegistry({ cap: 10, idleEvictionMs: idleTimeoutMs, evictionIntervalMs: 60_000 });
    const batchRegistry = new BatchRegistry();

    const dir = tmpDir();
    const r = registry.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.projectContext;

    // Cancel the reservation so activeRequests/pendingReservations are zero
    registry.cancelReservation(pc.cwd);

    // Register a non-terminal batch (state: 'pending') for this cwd
    batchRegistry.register({
      batchId: 'batch-1',
      projectCwd: pc.cwd,
      tool: 'delegate',
      state: 'pending',
      startedAt: Date.now(),
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
    });

    // Advance time past idle threshold
    vi.setSystemTime(Date.now() + idleTimeoutMs + 1_000);
    // Manually backdate lastActivityAt to be past the threshold
    pc.lastActivityAt = Date.now() - idleTimeoutMs - 2_000;

    // Evict with batchRegistry — project should NOT be evicted because batch is active
    registry.evictIdle(batchRegistry);
    expect(registry.size).toBe(1);
    expect(registry.get(pc.cwd)).toBeDefined();
  });

  it('project with activeRequests === 0 AND no active batches past idle IS evicted', () => {
    vi.useFakeTimers();
    const idleTimeoutMs = 5_000;
    const registry = new ProjectRegistry({ cap: 10, idleEvictionMs: idleTimeoutMs, evictionIntervalMs: 60_000 });
    const batchRegistry = new BatchRegistry();

    const dir = tmpDir();
    const r = registry.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.projectContext;

    // Cancel the reservation so pendingReservations drops to zero
    registry.cancelReservation(pc.cwd);

    // No batches registered — countActiveForProject returns 0

    // Backdate lastActivityAt past idle threshold
    pc.lastActivityAt = Date.now() - idleTimeoutMs - 1_000;

    registry.evictIdle(batchRegistry);
    expect(registry.size).toBe(0);
    expect(registry.get(pc.cwd)).toBeUndefined();
  });

  it('awaiting_clarification state counts as active (blocks eviction)', () => {
    vi.useFakeTimers();
    const idleTimeoutMs = 5_000;
    const registry = new ProjectRegistry({ cap: 10, idleEvictionMs: idleTimeoutMs, evictionIntervalMs: 60_000 });
    const batchRegistry = new BatchRegistry({ clarificationTimeoutMs: 24 * 60 * 60 * 1000 });

    const dir = tmpDir();
    const r = registry.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.projectContext;

    // Cancel reservation so pendingReservations = 0
    registry.cancelReservation(pc.cwd);

    // Register a batch, then transition to awaiting_clarification
    batchRegistry.register({
      batchId: 'batch-2',
      projectCwd: pc.cwd,
      tool: 'delegate',
      state: 'pending',
      startedAt: Date.now(),
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
    });
    batchRegistry.requestClarification('batch-2', 'Did you mean option A or B?');

    // Verify awaiting_clarification is non-terminal
    expect(batchRegistry.countActiveForProject(pc.cwd)).toBe(1);

    // Backdate lastActivityAt past idle threshold
    pc.lastActivityAt = Date.now() - idleTimeoutMs - 1_000;

    // Project should NOT be evicted — clarification batch is still active
    registry.evictIdle(batchRegistry);
    expect(registry.size).toBe(1);
    expect(registry.get(pc.cwd)).toBeDefined();
  });
});
