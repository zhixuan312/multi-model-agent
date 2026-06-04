import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'X-MMA-Main-Model': 'claude-opus-4-7',
      'X-MMA-Client': 'claude-code',
      Authorization: `Bearer ${token}`,
    },
  });
}

describe('contract: worker file-write confinement', () => {
  it('hard-fails a task whose reported writes escaped the dispatched cwd', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'mma-confine-'));
    // A path clearly outside the dispatched cwd (sibling of tmpDir under tmpdir()).
    // It need not exist on disk — the guard flags it lexically.
    const escapedPath = join(tmpdir(), 'mma-ESCAPED-by-worker.txt');

    // Worker self-reports a successful, approved task — but its write escaped cwd.
    const provider = mockProvider({
      stage: 'ok',
      sequence: [
        {
          status: 'ok',
          workerStatus: 'done',
          filesWritten: [escapedPath],
          specReviewStatus: 'approved',
          qualityReviewStatus: 'approved',
        },
      ],
    });

    const h = await boot({ provider, cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(
        `${h.baseUrl}/delegate?cwd=${encodeURIComponent(tmpDir)}`,
        h.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: [{ prompt: 'write a file', filePaths: [] }] }),
        },
      );
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      let terminal: Response | null = null;
      for (let i = 0; i < 60; i++) {
        const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token);
        if (poll.status === 200) { terminal = poll; break; }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(terminal).not.toBeNull();

      const body = (await terminal!.json()) as { structuredReport: { workerStatus: string } };
      // Without the guard this would be 'done'; the escape forces 'failed'.
      expect(body.structuredReport.workerStatus).toBe('failed');
    } finally {
      await h.close();
    }
  });
});
