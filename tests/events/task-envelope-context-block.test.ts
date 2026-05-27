import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

const seed = {
  taskId: 't0', batchId: 'b1', taskIndex: 0,
  route: 'audit' as const, agentType: 'complex' as const,
  client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
  reviewPolicy: 'none' as const,
};

describe('TaskEnvelope contextBlockId', () => {
  it('initializes contextBlockId to null', () => {
    const env = TaskEnvelopeStore.create(seed);
    expect(env.snapshot().contextBlockId).toBeNull();
  });

  it('seal() writes contextBlockId onto the envelope', () => {
    const env = TaskEnvelopeStore.create(seed);
    env.seal({ status: 'done', stopReason: null, realFilesChanged: [], contextBlockId: 'terminal-b1-0' });
    expect(env.snapshot().contextBlockId).toBe('terminal-b1-0');
  });

  it('seal() defaults contextBlockId to null when omitted', () => {
    const env = TaskEnvelopeStore.create(seed);
    env.seal({ status: 'done', stopReason: null, realFilesChanged: [] });
    expect(env.snapshot().contextBlockId).toBeNull();
  });
});
