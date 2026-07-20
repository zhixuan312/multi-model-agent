import { describe, it, expect } from 'vitest';
import { createProjectContext } from '../../packages/core/src/stores/project-context-registry.js';

describe('createProjectContext', () => {
  it('initializes all stores with the given cwd', () => {
    const pc = createProjectContext('/tmp/abc');
    expect(pc.cwd).toBe('/tmp/abc');
    expect(pc.contextBlocks).toBeDefined();
  });

  it('starts with empty counters', () => {
    const pc = createProjectContext('/tmp/abc');
    expect(pc.pendingReservations).toBe(0);
  });

  it('sets createdAt and lastActivityAt to now', () => {
    const before = Date.now();
    const pc = createProjectContext('/tmp/abc');
    const after = Date.now();
    expect(pc.createdAt).toBeGreaterThanOrEqual(before);
    expect(pc.createdAt).toBeLessThanOrEqual(after);
    expect(pc.lastActivityAt).toBe(pc.createdAt);
  });

  it('has mutable pendingReservations and lastActivityAt', () => {
    const pc = createProjectContext('/tmp/abc');
    pc.pendingReservations = 2;
    pc.lastActivityAt = 12345;
    expect(pc.pendingReservations).toBe(2);
    expect(pc.lastActivityAt).toBe(12345);
  });
});
