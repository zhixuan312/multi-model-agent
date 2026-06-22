import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { startTestServer } from '../fixtures/start-test-server.js';
import { setDraining, isDraining } from '../../../packages/server/src/http/request-pipeline.js';

function makeGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
}

describe('shutdown drain', () => {
  it('once draining flag is set, new dispatches return 503 service_unavailable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'drain-503-'));
    makeGitRepo(cwd);
    const server = await startTestServer({ cwd });
    const headers = {
      Authorization: `Bearer ${server.token}`,
      'X-MMA-Client': 'claude-code',
      'X-MMA-Main-Model': 'claude-opus-4-7',
      'Content-Type': 'application/json',
    };
    try {
      // Sanity: dispatch works pre-drain.
      const ok = await fetch(`${server.baseUrl}/task?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST', headers, body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/noop.ts'] } }),
      });
      expect(ok.status).toBe(202);

      // Flip drain flag — new dispatches must 503.
      setDraining(true);
      try {
        const denied = await fetch(`${server.baseUrl}/task?cwd=${encodeURIComponent(cwd)}`, {
          method: 'POST', headers, body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/noop.ts'] } }),
        });
        expect(denied.status).toBe(503);
        const body = await denied.json() as { error?: string | { code?: string } };
        // The startTestServer fetch adapter transforms /task error responses
        // from { error: { code } } to { error: code } (a string).
        const code = typeof body.error === 'string' ? body.error : body.error?.code;
        expect(code).toBe('service_unavailable');

        // /health stays available.
        const health = await fetch(`${server.baseUrl}/health`);
        expect(health.status).toBe(200);
      } finally {
        setDraining(false);
      }
      expect(isDraining()).toBe(false);
    } finally {
      await server.close();
    }
  });
});
