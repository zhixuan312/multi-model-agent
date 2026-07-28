import { ExecutionScope } from '../../../packages/server/src/application/execution-scope.js';

describe('ExecutionScope', () => {
  it('exposes a real abort channel: abort() fires the signal it handed out', () => {
    const scope = new ExecutionScope('exec-1');
    const signal = scope.signal;
    expect(signal.aborted).toBe(false);
    scope.abort('caller cancelled');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('caller cancelled');
  });

  it('drains cleanups newest-first (LIFO)', async () => {
    const scope = new ExecutionScope('exec-2');
    const order: string[] = [];
    scope.registerCleanup(() => { order.push('first-registered'); });
    scope.registerCleanup(() => { order.push('second-registered'); });
    await scope.drain();
    expect(order).toEqual(['second-registered', 'first-registered']);
  });

  it('a throwing cleanup never blocks the others', async () => {
    const scope = new ExecutionScope('exec-3');
    const ran: string[] = [];
    scope.registerCleanup(() => { ran.push('a'); });
    scope.registerCleanup(() => { throw new Error('boom'); });
    scope.registerCleanup(async () => { ran.push('c'); });
    await scope.drain();
    expect(ran).toEqual(['c', 'a']);
  });

  it('drain is idempotent — a second drain runs nothing', async () => {
    const scope = new ExecutionScope('exec-4');
    let count = 0;
    scope.registerCleanup(() => { count += 1; });
    await scope.drain();
    await scope.drain();
    expect(count).toBe(1);
  });
});
