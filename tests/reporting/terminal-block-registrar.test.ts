import { describe, it, expect } from 'vitest';
import { TerminalBlockRegistrar } from '../../packages/core/src/reporting/terminal-block-registrar.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';

function makeRegistry() {
  const blocks = new Map<string, string>();
  return {
    recordTerminalBlock(batchId: string, taskIndex: number, blockId: string) {
      blocks.set(`${batchId}:${taskIndex}`, blockId);
    },
    getTerminalBlock(batchId: string, taskIndex: number): string | undefined {
      return blocks.get(`${batchId}:${taskIndex}`);
    },
  };
}

describe('TerminalBlockRegistrar', () => {
  it('registers a block and records to registry', () => {
    const store = new InMemoryContextBlockStore();
    const reg = makeRegistry();
    const r = new TerminalBlockRegistrar(store, reg);
    const id = r.register({ batchId: 'b1', taskIndex: 0, route: 'delegate', markdown: '## Done' });
    expect(id).toBe('terminal-b1-0');
    expect(store.get('terminal-b1-0')).toBe('## Done');
    expect(reg.getTerminalBlock('b1', 0)).toBe('terminal-b1-0');
  });

  it('skips register_context_block route', () => {
    const store = new InMemoryContextBlockStore();
    const reg = makeRegistry();
    const r = new TerminalBlockRegistrar(store, reg);
    expect(r.register({ batchId: 'b1', taskIndex: 0, route: 'register-context-block', markdown: 'x' })).toBeUndefined();
  });
});
