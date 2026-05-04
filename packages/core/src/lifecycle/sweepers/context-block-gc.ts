import type { ContextBlockStore } from '../../context/context-block-store.js';

export class ContextBlockGCSweeper {
  constructor(
    private store: ContextBlockStore,
    private idleTtlMs: number,
  ) {}

  tick(): number {
    return this.store.runIdleSweep(Date.now(), this.idleTtlMs);
  }
}
