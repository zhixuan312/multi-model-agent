import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('Precondition P1 — read-route dispatch bypass (static-source verification)', () => {
  it('perform-implementation.ts prefers parallelTarget over task.prompt for read routes', () => {
    const src = read('packages/core/src/lifecycle/perform-implementation.ts');
    // The bypass relies on: const targetContent = parallelTarget?.trim() ? parallelTarget : (document?.trim() ? document : task.prompt);
    expect(src).toMatch(/parallelTarget/);
    expect(src).toMatch(/parallelTarget.*\?.*parallelTarget.*:/s);
  });

  it('all 5 read-only tool-configs set parallelTarget in buildTaskSpec', () => {
    for (const route of ['audit', 'review', 'debug', 'investigate', 'research']) {
      const path = `packages/core/src/tools/${route}/tool-config.ts`;
      const src = read(path);
      // Each tool-config's buildTaskSpec must set parallelTarget so the dispatch bypass kicks in
      expect(src, `${route} tool-config must set parallelTarget`).toMatch(/parallelTarget\s*:/);
    }
  });

  it('read-route-criteria.ts defines FINDING_FORMAT_SHARED', () => {
    const src = read('packages/core/src/lifecycle/read-route-criteria.ts');
    expect(src).toMatch(/FINDING_FORMAT_SHARED/);
  });
});
