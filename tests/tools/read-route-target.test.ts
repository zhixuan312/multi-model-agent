import { describe, it, expect } from 'vitest';
import { toolConfig as review } from '../../packages/core/src/tools/review/tool-config.js';
import { toolConfig as debug } from '../../packages/core/src/tools/debug/tool-config.js';
import { toolConfig as investigate } from '../../packages/core/src/tools/investigate/tool-config.js';

// Invariant (positive half): every read-only route's buildTaskSpec sets a
// non-empty readTarget. perform-implementation throws
// `read_route_missing_target` if a non-research read route reaches dispatch
// with an empty target (the negative half — the silent task.prompt fallback
// was removed in plan task 5).

const ctx = {
  cwd: '/tmp',
  projectContext: { cwd: '/tmp' },
  config: { defaults: {} },
  mainModel: 'claude-opus-4-7',
} as any;

function target(spec: any): string {
  return (spec.readTarget ?? spec.readTarget ?? '') as string;
}

describe('read-route buildTaskSpec sets a non-empty target', () => {
  it('review', () => {
    const spec = review.buildTaskSpec(
      { code: undefined, filePaths: ['a.ts'], focus: [], hasContextBlocks: false, contextBlockIds: [] } as any,
      ctx,
    );
    expect(target(spec).trim().length).toBeGreaterThan(0);
  });

  it('debug', () => {
    const spec = debug.buildTaskSpec(
      { problem: 'crash on login', filePaths: ['a.ts'], contextBlockIds: [] } as any,
      ctx,
    );
    expect(target(spec).trim().length).toBeGreaterThan(0);
  });

  it('investigate', () => {
    const spec = investigate.buildTaskSpec(
      { question: 'how does X work', filePaths: [], contextBlockIds: [] } as any,
      ctx,
    );
    expect(target(spec).trim().length).toBeGreaterThan(0);
  });
});
