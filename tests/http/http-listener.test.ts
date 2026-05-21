import { describe, it, expect, vi, afterEach } from 'vitest';
import { HTTPListener } from '../../packages/core/src/transport/http-listener.js';

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
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[mmagent] listener handler rejected:'));
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
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[mmagent] listener handler rejected:'));
    errSpy.mockRestore();
  });

  it('stop() is idempotent', async () => {
    const l = new HTTPListener({ bind: '127.0.0.1', port: 0, handler: (_req, res) => { res.end(); } });
    await l.start();
    await l.stop();
    await expect(l.stop()).resolves.toBeUndefined();
  });
});
