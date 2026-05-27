// tests/contract/http/batch-context-block.test.ts
import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../../packages/core/src/events/task-envelope.js';
// envelopeToPublicResult is exported from batch.ts in Step 3 below (it is
// currently module-private). We assert the projection directly on a sealed
// envelope snapshot.
import { envelopeToPublicResult } from '../../../packages/server/src/http/handlers/control/batch.js';

function sealed(route: 'audit' | 'delegate', contextBlockId: string | null) {
  const env = TaskEnvelopeStore.create({
    taskId: 't0', batchId: 'b1', taskIndex: 0, route, agentType: 'complex',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'none',
  });
  env.seal({ status: 'done', stopReason: null, realFilesChanged: [], contextBlockId });
  return env.snapshot();
}

describe('envelopeToPublicResult contextBlockId', () => {
  it('projects contextBlockId for read routes', () => {
    const r = envelopeToPublicResult(sealed('audit', 'terminal-b1-0')) as any;
    expect(r.contextBlockId).toBe('terminal-b1-0');
  });
  it('projects null for write routes', () => {
    const r = envelopeToPublicResult(sealed('delegate', null)) as any;
    expect(r.contextBlockId).toBeNull();
  });
});
