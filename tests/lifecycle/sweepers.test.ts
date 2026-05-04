import { describe, it, expect, vi } from 'vitest';
import { BatchRetentionSweeper } from '../../packages/core/src/lifecycle/sweepers/batch-retention.js';
import { ProjectIdleCleanup } from '../../packages/core/src/lifecycle/sweepers/project-idle-cleanup.js';
import { ContextBlockGCSweeper } from '../../packages/core/src/lifecycle/sweepers/context-block-gc.js';
import { ShutdownCoordinator } from '../../packages/core/src/lifecycle/sweepers/shutdown-coordinator.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/context/context-block-store.js';
import type { ProjectContext } from '../../packages/core/src/project-context.js';

describe('BatchRetentionSweeper', () => {
  it('tick calls registry.runExpirySweep', () => {
    const runExpirySweep = vi.fn();
    const sweeper = new BatchRetentionSweeper({ runExpirySweep } as any);
    sweeper.tick();
    expect(runExpirySweep).toHaveBeenCalledOnce();
  });
});

describe('ProjectIdleCleanup', () => {
  it('removes projects past the idle threshold', () => {
    const now = Date.now();
    const active: ProjectContext = {
      cwd: '/active',
      contextBlocks: new InMemoryContextBlockStore(),
      batchCache: {} as any,
      clarifications: {} as any,
      createdAt: now,
      lastActivityAt: now,
      activeSessions: new Set(),
      activeRequests: 0,
      pendingReservations: 0,
    };
    const idle: ProjectContext = {
      ...active,
      cwd: '/idle',
      lastActivityAt: now - 60_000,
    };

    const projects = new Map<string, ProjectContext>([
      ['/active', active],
      ['/idle', idle],
    ]);

    const cleaner = new ProjectIdleCleanup(projects);
    cleaner.tick(30_000);

    expect(projects.has('/active')).toBe(true);
    expect(projects.has('/idle')).toBe(false);
  });

  it('keeps all projects when none exceed threshold', () => {
    const projects = new Map<string, ProjectContext>();
    const cleaner = new ProjectIdleCleanup(projects);
    cleaner.tick(60_000);
    expect(projects.size).toBe(0);
  });
});

describe('ContextBlockGCSweeper', () => {
  it('tick delegates to store.runIdleSweep', () => {
    const store = new InMemoryContextBlockStore();
    const sweeper = new ContextBlockGCSweeper(store, 100);

    store.register('hello');
    store.register('world');

    // Nothing idle yet
    const evicted0 = sweeper.tick();
    expect(evicted0).toBe(0);
    expect(store.size).toBe(2);
  });

  it('evicts entries past idle TTL', () => {
    const store = new InMemoryContextBlockStore();

    store.register('hello');
    store.register('world');

    const future = Date.now() + 100_000;
    const evicted = store.runIdleSweep(future, 50);
    expect(evicted).toBe(2);
    expect(store.size).toBe(0);
  });

  it('skips pinned entries during sweep', () => {
    const store = new InMemoryContextBlockStore();
    const { id } = store.register('pinned');
    store.pin(id);
    store.register('unpinned');

    const evicted = store.runIdleSweep(Date.now() + 100_000, 50);
    expect(evicted).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get(id)).toBe('pinned');
  });
});

describe('ShutdownCoordinator', () => {
  it('starts with shutdown not in progress', () => {
    const c = new ShutdownCoordinator();
    expect(c.isShutdownInProgress()).toBe(false);
  });

  it('signal flips state to in-progress', () => {
    const c = new ShutdownCoordinator();
    c.signal();
    expect(c.isShutdownInProgress()).toBe(true);
  });

  it('drain executes the action and resolves', async () => {
    const c = new ShutdownCoordinator();
    let called = false;
    await c.drain(async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
