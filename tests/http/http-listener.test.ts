import { describe, it, expect, vi, afterEach } from 'bun:test';
import { HTTPListener } from '../../packages/core/src/transport/http-listener.js';

describe('HTTPListener', () => {
  const started: HTTPListener[] = [];
  afterEach(async () => { for (const l of started) await l.stop(); started.length = 0; });
  function track(l: HTTPListener): HTTPListener { started.push(l); return l; }

  it('start() binds an ephemeral port and invokes the handler', async () => {
    let seen = false;
    const l = track(new HTTPListener({
      bind: '127.0.0.1', port: 0,
      handler: () => { seen = true; return new Response('ok', { status: 200 }); },
    }));
    const { port, address } = await l.start();
    expect(port).toBeGreaterThan(0);
    expect(address).toBeTruthy();
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(seen).toBe(true);
  });

  it('handler receives the Request and the server (for requestIP)', async () => {
    const l = track(new HTTPListener({
      bind: '127.0.0.1', port: 0,
      handler: (req, server) => {
        const ip = server.requestIP(req)?.address ?? 'none';
        return new Response(JSON.stringify({ path: new URL(req.url).pathname, ipSeen: ip !== 'none' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    }));
    const { port } = await l.start();
    const r = await fetch(`http://127.0.0.1:${port}/echo`);
    expect(r.status).toBe(200);
    const body = await r.json() as { path: string; ipSeen: boolean };
    expect(body.path).toBe('/echo');
    expect(body.ipSeen).toBe(true);
  });

  it('rejecting handler → logs to stderr and returns 500 internal_error', async () => {
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

  it('stop() is idempotent', async () => {
    const l = new HTTPListener({ bind: '127.0.0.1', port: 0, handler: () => new Response(null, { status: 204 }) });
    await l.start();
    await l.stop();
    await expect(l.stop()).resolves.toBeUndefined();
  });
});
