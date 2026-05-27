import { describe, it, expect } from 'bun:test';
import { TerminalBlockRegistrar } from '../../packages/core/src/reporting/terminal-block-registrar.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

describe('TerminalBlockRegistrar', () => {
  it('registers a block and records to BatchRegistry', () => {
    const store = new InMemoryContextBlockStore();
    const reg = new BatchRegistry();
    reg.register({ batchId: 'b1', projectCwd: '/tmp', tool: 'delegate', state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false });
    const r = new TerminalBlockRegistrar(store, reg);
    const id = r.register({ batchId: 'b1', taskIndex: 0, route: 'delegate', markdown: '## Done' });
    expect(id).toBe('terminal-b1-0');
    expect(store.get('terminal-b1-0')).toBe('## Done');
    expect(reg.getTerminalBlock('b1', 0)).toBe('terminal-b1-0');
  });

  it('skips register_context_block route', () => {
    const store = new InMemoryContextBlockStore();
    const reg = new BatchRegistry();
    const r = new TerminalBlockRegistrar(store, reg);
    expect(r.register({ batchId: 'b1', taskIndex: 0, route: 'register-context-block', markdown: 'x' })).toBeUndefined();
  });
});
