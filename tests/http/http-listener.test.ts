import { describe, it, expect, vi, afterEach } from 'vitest';
import { HTTPListener, PortInUseError, logLateSocketError } from '../../packages/core/src/transport/http-listener.js';

describe('HTTPListener', () => {
  const started: HTTPListener[] = [];
  afterEach(async () => { for (const l of started) await l.stop(); started.length = 0; });
  function track(l: HTTPListener): HTTPListener { started.push(l); return l; }

  it('start() binds an ephemeral port and invokes the handler', async () => {
    let seen = false;
    const l = track(new HTTPListener({
      bind: '127.0.0.1', port: 0,
      handler: (_req, res) => { seen = true; res.writeHead(200); res.end('ok'); },
    }));
    const { port, address } = await l.start();
    expect(port).toBeGreaterThan(0);
    expect(address).toBeTruthy();
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    expect(seen).toBe(true);
  });

  it('rejecting handler (headers unsent) → logs to stderr and returns 500 internal_error', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const l = track(new HTTPListener({
      bind: '127.0.0.1', port: 0,
      handler: async () => { throw new Error('boom'); },
    }));
    const { port } = await l.start();
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(500);
    const body = await r.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[mma] listener handler rejected:'));
    errSpy.mockRestore();
  });

  it('rejecting handler (headers already sent) → ends response, logs, no crash', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const l = track(new HTTPListener({
      bind: '127.0.0.1', port: 0,
      handler: async (_req, res) => { res.writeHead(200); res.write('partial'); throw new Error('late'); },
    }));
    const { port } = await l.start();
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);            // headers already committed
    expect(await r.text()).toBe('partial'); // response ended cleanly, no hang
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[mma] listener handler rejected:'));
    errSpy.mockRestore();
  });

  it('stop() is idempotent', async () => {
    const l = new HTTPListener({ bind: '127.0.0.1', port: 0, handler: (_req, res) => { res.end(); } });
    await l.start();
    await l.stop();
    await expect(l.stop()).resolves.toBeUndefined();
  });

  // Before this, `listen` had no 'error' listener, so an occupied port emitted
  // an unhandled 'error' event: the start() promise never settled and Node
  // raised an uncaught exception. A daemon started in the background then died
  // with its output redirected to a file nobody reads, which is why "I restarted
  // it" and "it restarted" came apart so often.
  it('start() on an occupied port rejects with PortInUseError rather than crashing', async () => {
    const first = track(new HTTPListener({
      bind: '127.0.0.1', port: 0, handler: (_req, res) => { res.end(); },
    }));
    const { port } = await first.start();

    const second = new HTTPListener({ bind: '127.0.0.1', port, handler: (_req, res) => { res.end(); } });
    await expect(second.start()).rejects.toBeInstanceOf(PortInUseError);
  });

  it('PortInUseError names the address and port the caller must report', async () => {
    const first = track(new HTTPListener({
      bind: '127.0.0.1', port: 0, handler: (_req, res) => { res.end(); },
    }));
    const { port } = await first.start();

    const second = new HTTPListener({ bind: '127.0.0.1', port, handler: (_req, res) => { res.end(); } });
    const err = await second.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as PortInUseError).code).toBe('EADDRINUSE');
    expect((err as PortInUseError).port).toBe(port);
    expect((err as PortInUseError).bind).toBe('127.0.0.1');
    expect((err as PortInUseError).message).toContain(String(port));
  });

  // A bind failure that is NOT a port conflict must surface as itself. Mapping
  // every listen error onto PortInUseError would send the operator to
  // `mma restart` for a problem restarting cannot fix.
  it('start() propagates a non-EADDRINUSE bind failure unchanged', async () => {
    const l = new HTTPListener({
      // Not an address on this host, so bind fails with EADDRNOTAVAIL.
      bind: '203.0.113.1', port: 0, handler: (_req, res) => { res.end(); },
    });
    const err = await l.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PortInUseError);
  });

  // The startup handler must be replaced once listening, not left attached: a
  // socket error arriving later with no listener terminates the process.
  //
  // Tested through the exported handler rather than by emitting on the
  // listener's private `server` field. Casting past `private` to reach internal
  // state locks a test to the field name instead of the behaviour, and adding a
  // seam to production code purely so a test can reach in is the same mistake
  // wearing a nicer hat.
  it('logs a late socket error without rethrowing', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => logLateSocketError(new Error('late socket failure'))).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('listener socket error: late socket failure'));
    errSpy.mockRestore();
  });
});
