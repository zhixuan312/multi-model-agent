import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';

describe('EventEmitter.off()', () => {
  it('removes a registered listener so it no longer receives events', () => {
    const bus = new EventEmitter();
    const received: unknown[] = [];
    const handler = (e: Record<string, unknown>) => { received.push(e); };
    bus.on(handler);
    bus.emit({ event: 'first' });
    bus.off(handler);
    bus.emit({ event: 'second' });
    expect(received.length).toBe(1);
    expect((received[0] as { event: string }).event).toBe('first');
  });

  it('is a no-op when the listener was never registered', () => {
    const bus = new EventEmitter();
    const handler = () => {};
    expect(() => bus.off(handler)).not.toThrow();
  });

  it('only removes the exact listener reference (not other registrations)', () => {
    const bus = new EventEmitter();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const ha = (e: Record<string, unknown>) => { a.push(e); };
    const hb = (e: Record<string, unknown>) => { b.push(e); };
    bus.on(ha);
    bus.on(hb);
    bus.off(ha);
    bus.emit({ event: 'x' });
    expect(a.length).toBe(0);
    expect(b.length).toBe(1);
  });
});
