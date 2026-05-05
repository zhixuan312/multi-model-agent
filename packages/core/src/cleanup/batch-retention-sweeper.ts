import type { BatchRegistry } from '../stores/batch-registry.js';

export class BatchRetentionSweeper {
  constructor(private registry: BatchRegistry) {}

  tick(): void {
    this.registry.runExpirySweep();
  }
}
