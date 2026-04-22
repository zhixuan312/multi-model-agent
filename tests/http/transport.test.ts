import { describe, it, expect, afterEach } from 'vitest';
import { startTestDaemon } from '../helpers/mmagent-test-daemon.js';
import { connectTestClient } from '../helpers/http-test-client.js';
import { createTempProject } from '../helpers/temp-project.js';

describe('HTTP transport startup', () => {
  let handles: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(handles.map(h => h.stop())); handles = []; });

  it('refuses to start when bind is non-loopback and auth is disabled', async () => {
    await expect(
      startTestDaemon({ bind: '0.0.0.0', auth: { enabled: false, tokenPath: '~' } }),
    ).rejects.toThrow(/loopback|auth/);
  });

  it('starts on a random port and answers /status', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const res = await fetch(`${d.url}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transport).toBe('http');
  });

  it('rejects missing cwd with 400', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const res = await fetch(d.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing_cwd');
  });

  it('rejects invalid cwd with 400', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const res = await fetch(`${d.url}/?cwd=/does/not/exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects query-string token with 401 when auth is enabled', async () => {
    const { cwd, cleanup } = createTempProject();
    try {
      const d = await startTestDaemon({
        auth: { enabled: true, tokenPath: `/tmp/test-token-${Date.now()}` },
      });
      handles.push(d);
      const res = await fetch(`${d.url}/?cwd=${encodeURIComponent(cwd)}&token=anything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}',
      });
      expect(res.status).toBe(401);
    } finally {
      cleanup();
    }
  });

  it('accepts initialize with valid cwd and returns Mcp-Session-Id', async () => {
    const { cwd, cleanup } = createTempProject();
    try {
      const d = await startTestDaemon();
      handles.push(d);
      const { client, close } = await connectTestClient({ url: d.url, cwd });
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await close();
    } finally {
      cleanup();
    }
  });
});
