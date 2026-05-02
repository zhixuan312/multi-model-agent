import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Provider, ProviderConfig, RunResult, RunStatus, TokenUsage, AttemptRecord } from '@zhixuan92/multi-model-agent-core';
import { boot } from './fixtures/harness.js';

const STUB_CONFIG: ProviderConfig = {
  type: 'openai-compatible',
  baseUrl: 'http://mock.local',
  apiKey: 'mock',
  model: 'mock-model',
} as ProviderConfig;

function stubUsage(): TokenUsage {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 };
}

function stubAttempt(status: RunStatus): AttemptRecord {
  return {
    provider: 'mock-cwd-capture',
    status,
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
    costUSD: 0.001,
    initialPromptLengthChars: 0,
    initialPromptHash: '',
  };
}

function stubOkResult(): RunResult {
  return {
    output: '## Summary\napproved\n\nNo issues found.',
    status: 'ok',
    usage: stubUsage(),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [stubAttempt('ok')],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function cwdCapturingProvider(capturedCwds: string[]): Provider {
  return {
    name: 'mock-cwd-capture',
    config: STUB_CONFIG,
    async run(_prompt: string, options?: { cwd?: string }): Promise<RunResult> {
      if (options?.cwd) {
        capturedCwds.push(options.cwd);
      }
      return stubOkResult();
    },
  };
}

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe('contract: reviewer cwd threading', () => {
  it('quality and spec reviewers receive task.cwd in provider.run options', async () => {
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

      // Poll for terminal
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

      // Every captured cwd from provider.run must resolve to the same
      // canonical path as tmpDir (cwd-validator uses realpathSync).
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
