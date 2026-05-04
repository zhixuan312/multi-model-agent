import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../../packages/core/src/channels/event-emitter.js';

describe('EventEmitter', () => {
  it('redacts secrets before fan-out', () => {
    const captured: any[] = [];
    const e = new EventEmitter();
    e.on(ev => captured.push(ev));
    e.emit({ message: 'sk-abcdefghijklmnopqrst1234' });
    expect(captured[0].message).toBe('[REDACTED-API-KEY]');
  });
  it('fans out to all listeners', () => {
    const a: any[] = [], b: any[] = [];
    const e = new EventEmitter();
    e.on(ev => a.push(ev));
    e.on(ev => b.push(ev));
    e.emit({ x: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
