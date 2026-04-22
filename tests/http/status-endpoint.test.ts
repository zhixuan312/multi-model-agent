import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { startTestDaemon } from '../helpers/mmagent-test-daemon.js';
import { createTempProject } from '../helpers/temp-project.js';
import { connectTestClient } from '../helpers/http-test-client.js';

describe('/status endpoint', () => {
  let handles: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(handles.map(h => h.stop())); handles = []; });

  it('returns daemon + projects JSON with clarificationsSize', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const { cwd, cleanup } = createTempProject();
    try {
      const { close } = await connectTestClient({ url: d.url, cwd });
      const res = await fetch(`${d.url}/status`);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('pid');
      expect(body.transport).toBe('http');
      const projects = body.projects as Array<Record<string, unknown>>;
      expect(projects.length).toBe(1);
      expect(projects[0].cwd).toBe(fs.realpathSync(cwd));
      expect(projects[0].activeSessions).toBe(1);
      expect(projects[0].batchCacheSize).toBe(0);
      expect(projects[0].contextBlocksSize).toBe(0);
      expect(projects[0].clarificationsSize).toBe(0);
      expect(Array.isArray(body.activeRequests)).toBe(true);
      expect(Array.isArray(body.recent)).toBe(true);
      await close();
    } finally {
      cleanup();
    }
  });

  it('returns 401 when auth enabled and token missing', async () => {
    const tokenPath = `/tmp/status-token-${Date.now()}`;
    try {
      const d = await startTestDaemon({
        auth: { enabled: true, tokenPath },
      });
      handles.push(d);
      const res = await fetch(`${d.url}/status`);
      expect(res.status).toBe(401);
    } finally {
      if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    }
  });

  it('reports actual bound port after listen (not configured port)', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const res = await fetch(`${d.url}/status`);
    const body = await res.json() as Record<string, unknown>;
    // d.url looks like "http://127.0.0.1:12345"; extract port.
    const expectedPort = new URL(d.url).port;
    expect(body.bind).toContain(`:${expectedPort}`);
  });
});
