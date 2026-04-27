import { describe, it, expect, vi } from 'vitest';
import { EventBus, type EventSink } from '../../packages/core/src/observability/bus.js';
import type { EventType } from '../../packages/core/src/observability/events.js';

describe('EventBus', () => {
  it('fans out to all sinks', () => {
    const a = vi.fn();
    const b = vi.fn();
    const bus = new EventBus([{ name: 'a', emit: a }, { name: 'b', emit: b }]);
    const ev: EventType = { event: 'task_started', ts: '2026-04-27T00:00:00Z', batchId: '00000000-0000-0000-0000-000000000001', taskIndex: 0, route: 'delegate', cwd: '/tmp' } as EventType;
    bus.emit(ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it('one sink throwing does not block others', () => {
    const ok = vi.fn();
    const boom: EventSink = { name: 'boom', emit: () => { throw new Error('x'); } };
    const bus = new EventBus([boom, { name: 'ok', emit: ok }]);
    expect(() => bus.emit({ event: 'task_started', ts: '2026-04-27T00:00:00Z', batchId: '00000000-0000-0000-0000-000000000001', taskIndex: 0, route: 'delegate', cwd: '/' } as EventType)).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });
});
