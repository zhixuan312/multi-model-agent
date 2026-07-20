import { describe, it, expect, vi } from 'vitest';
import { EnvelopeBus, type Subscriber } from '../../packages/core/src/events/envelope-bus.js';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

const seed = { taskId: 't', batchId: 'b', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'm', cwd: '/tmp', reviewPolicy: 'reviewed' as const };

describe('EnvelopeBus', () => {
  it('delivers envelope snapshots to all subscribers', () => {
    const bus = new EnvelopeBus();
    const s1 = { name: 's1', receive: vi.fn() } satisfies Subscriber;
    const s2 = { name: 's2', receive: vi.fn() } satisfies Subscriber;
    bus.subscribe(s1); bus.subscribe(s2);
    const env = TaskEnvelopeStore.create(seed).snapshot();
    bus.emitEnvelopeSnapshot(env, 'create');
    expect(s1.receive).toHaveBeenCalledWith({ type: 'envelope', envelope: env, reason: 'create' });
    expect(s2.receive).toHaveBeenCalledWith({ type: 'envelope', envelope: env, reason: 'create' });
  });

  it('delivers plain entries to all subscribers', () => {
    const bus = new EnvelopeBus();
    const s = { name: 's', receive: vi.fn() } satisfies Subscriber;
    bus.subscribe(s);
    bus.emitPlainEntry({ ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: { batch_id: 'b' } });
    expect(s.receive).toHaveBeenCalledTimes(1);
  });

  it('subscriber error does not crash producer or break other subscribers', () => {
    const bus = new EnvelopeBus();
    const bad = { name: 'bad', receive: () => { throw new Error('boom'); } } satisfies Subscriber;
    const good = { name: 'good', receive: vi.fn() } satisfies Subscriber;
    bus.subscribe(bad); bus.subscribe(good);
    expect(() => bus.emitPlainEntry({ ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: {} })).not.toThrow();
    expect(good.receive).toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EnvelopeBus();
    const s = { name: 's', receive: vi.fn() } satisfies Subscriber;
    const unsub = bus.subscribe(s);
    unsub();
    bus.emitPlainEntry({ ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: {} });
    expect(s.receive).not.toHaveBeenCalled();
  });
});
