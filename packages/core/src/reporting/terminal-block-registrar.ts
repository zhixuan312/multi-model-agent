import type { ContextBlockStore } from '../context/context-block-store.js';
import type { BatchRegistry } from '../batch-registry.js';

export class TerminalBlockRegistrar {
  constructor(private store: ContextBlockStore, private registry: BatchRegistry) {}

  register(opts: { batchId: string; taskIndex: number; route: string; markdown: string }): string | undefined {
    if (opts.route === 'register-context-block') return undefined;
    const blockId = `terminal-${opts.batchId}-${opts.taskIndex}`;
    this.store.register(opts.markdown, { id: blockId });
    this.registry.recordTerminalBlock(opts.batchId, opts.taskIndex, blockId);
    return blockId;
  }
}
