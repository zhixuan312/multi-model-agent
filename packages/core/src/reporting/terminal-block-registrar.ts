import type { ContextBlockStore } from '../stores/context-block-tool.js';

interface TerminalBlockRegistry {
  recordTerminalBlock(batchId: string, taskIndex: number, blockId: string): void;
}

export class TerminalBlockRegistrar {
  constructor(private store: ContextBlockStore, private registry: TerminalBlockRegistry) {}

  register(opts: { batchId: string; taskIndex: number; route: string; markdown: string }): string | undefined {
    if (opts.route === 'register-context-block') return undefined;
    const blockId = `terminal-${opts.batchId}-${opts.taskIndex}`;
    this.store.register(opts.markdown, { id: blockId });
    this.registry.recordTerminalBlock(opts.batchId, opts.taskIndex, blockId);
    return blockId;
  }
}
