import { describe, it, expect } from 'vitest';
import { createProjectContext } from '../../packages/core/src/stores/project-context-registry.js';

describe('createProjectContext', () => {
  it('initializes all stores with the given cwd', () => {
    const pc = createProjectContext('/tmp/abc');
    expect(pc.cwd).toBe('/tmp/abc');
    expect(pc.contextBlocks).toBeDefined();
  });

  it('sets createdAt and lastActivityAt to now', () => {
    const before = Date.now();
    const pc = createProjectContext('/tmp/abc');
    const after = Date.now();
    expect(pc.createdAt).toBeGreaterThanOrEqual(before);
    expect(pc.createdAt).toBeLessThanOrEqual(after);
    expect(pc.lastActivityAt).toBe(pc.createdAt);
  });

  it('has a mutable lastActivityAt', () => {
    const pc = createProjectContext('/tmp/abc');
    pc.lastActivityAt = 12345;
    expect(pc.lastActivityAt).toBe(12345);
  });
});
