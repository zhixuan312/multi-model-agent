import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Provider, ProviderConfig } from '@zhixuan92/multi-model-agent-core';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';
import { boot } from './fixtures/harness.js';

const STUB_CONFIG: ProviderConfig = {
  type: 'codex',
  baseUrl: 'http://mock.local',
  apiKey: 'mock',
  model: 'mock-model',
} as ProviderConfig;

function cwdCapturingProvider(capturedCwds: string[]): Provider {
  return {
    name: 'mock-cwd-capture',
    config: STUB_CONFIG,
    openSession(opts: SessionOpts): Session {
      if (opts.cwd) capturedCwds.push(opts.cwd);
      return {
        async send(): Promise<TurnResult> {
          return {
            output: '## Summary\napproved\n\nNo issues found.',
            usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            filesWritten: [],
            turns: 1,
            durationMs: 0,
            costUSD: 0.001,
            terminationReason: 'ok',
            workerSelfAssessment: 'done',
          };
        },
        async close() { /* no-op */ },
      };
    },
  };
}

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

describe('contract: reviewer cwd threading', () => {
  it('quality and spec reviewers receive task.cwd in openSession options', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'mma-cwd-test-'));
    const capturedCwds: string[] = [];

    const h = await boot({ provider: cwdCapturingProvider(capturedCwds), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(tmpDir)}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'write a test file', filePaths: [] }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      let terminal: Response | null = null;
      for (let i = 0; i < 30; i++) {
        const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token);
        if (poll.status === 200) {
          terminal = poll;
          break;
        }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(terminal).not.toBeNull();

      const canonicalTmpDir = realpathSync(tmpDir);
      expect(capturedCwds.length).toBeGreaterThan(0);
      for (const c of capturedCwds) {
        expect(realpathSync(c)).toBe(canonicalTmpDir);
      }
    } finally {
      await h.close();
    }
  });
});
