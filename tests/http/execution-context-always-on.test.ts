import { describe, it, expect } from 'vitest';
import { buildExecutionContext } from '../../packages/server/src/http/execution-context.js';
import type { HandlerDeps } from '../../packages/server/src/http/handler-deps.js';
import type { ProjectContext, MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

function fakeDeps(diagnostics?: MultiModelConfig['diagnostics']): HandlerDeps {
  return {
    config: {
      ...(diagnostics ? { diagnostics } : {}),
    } as MultiModelConfig,
    logger: {} as any,
    bus: { emit: () => {}, on: () => () => {} } as any,
    projectRegistry: {} as any,
    batchRegistry: { get: () => undefined, updateRunningHeadlineSnapshot: () => {} } as any,
    routeDispatcher: {} as any,
  };
}

function fakeProjectContext(): ProjectContext {
  return { cwd: process.cwd(), contextBlocks: {} as any } as ProjectContext;
}

describe('buildExecutionContext — always-on verbose (A12)', () => {
  it('sets verbose=true and verboseStream=stderr regardless of config (no diagnostics)', () => {
    const ctx = buildExecutionContext(fakeDeps(undefined), fakeProjectContext(), 'batch-1');
    expect(ctx.verbose).toBe(true);
    expect(typeof ctx.verboseStream).toBe('function');

    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => { captured.push(s); return true; };
    try { ctx.verboseStream!('probe\n'); } finally { (process.stderr.write as any) = original; }
    expect(captured).toEqual(['probe\n']);
  });

  it('sets verbose=true even when config has diagnostics.log=false', () => {
    const ctx = buildExecutionContext(fakeDeps({ log: false }), fakeProjectContext(), 'batch-2');
    expect(ctx.verbose).toBe(true);
  });
});
