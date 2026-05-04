import type { BatchRegistry } from '../../batch-registry.js';

export class BatchRetentionSweeper {
  constructor(private registry: BatchRegistry) {}

  tick(): void {
    this.registry.runExpirySweep();
  }
}
