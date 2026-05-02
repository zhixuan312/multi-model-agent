import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecorder } from '../../packages/server/src/telemetry/recorder.js';
import type { BuildContext } from '../../packages/core/src/telemetry/event-builder.js';

const TEST_DIRS: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mma-test-warnings-'));
  TEST_DIRS.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
  return dir;
}

afterEach(() => {
  for (const dir of TEST_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/**
 * Poll the telemetry queue file until a valid event is enqueued.
 * `recordTaskCompleted` calls `queue.append()` in a fire-and-forget async
 * chain; we poll with a deadline to avoid a race on the write.
 */
async function readEnqueuedEvent(dir: string): Promise<Record<string, unknown>> {
  const queuePath = join(dir, 'telemetry-queue.ndjson');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
    if (!existsSync(queuePath)) continue;
    const content = readFileSync(queuePath, 'utf8');
    if (!content.trim()) continue;
    try {
      const lines = content.trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      if (last.events?.[0]) return last.events[0] as Record<string, unknown>;
    } catch {
      // partial write — retry
    }
  }
  throw new Error('Timed out waiting for enqueued event in queue file');
}

function makeHealthyContext(): BuildContext {
  return {
    route: 'delegate',
    taskSpec: { filePaths: [] },
    runResult: {
      status: 'ok',
      durationMs: 50000,
      workerStatus: 'done',
      usage: { inputTokens: 1000, outputTokens: 200, costUSD: 0.05 },
      models: { implementer: 'gpt-5', specReviewer: 'claude-sonnet', qualityReviewer: 'claude-sonnet' },
      agents: {
        implementer: 'standard' as const,
        implementerToolMode: 'full' as const,
        implementerCapabilities: [] as string[],
      },
      stageStats: {
        implementing: {
          stage: 'implementing', entered: true, durationMs: 30000, costUSD: 0.03,
          agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5',
          maxIdleMs: 1000, totalIdleMs: 5000, activityEvents: 20,
          inputTokens: 500, outputTokens: 100, cachedTokens: 50,
          reasoningTokens: 25, turnCount: 7, toolCallCount: 4,
          filesReadCount: 2, filesWrittenCount: 1,
        } as any,
        committing: {
          stage: 'committing', entered: true, durationMs: 500, costUSD: 0.001,
          agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5',
          maxIdleMs: 50, totalIdleMs: 100, activityEvents: 1,
          inputTokens: 100, outputTokens: 50, cachedTokens: 10,
          reasoningTokens: 5, turnCount: 1, toolCallCount: 1,
          filesReadCount: 1, filesWrittenCount: 1,
        } as any,
      },
      terminationReason: {
        cause: 'finished' as const,
        turnsUsed: 14,
        hasFileArtifacts: true,
        usedShell: false,
        workerSelfAssessment: 'done' as const,
        wasPromoted: false,
      },
      commits: [],
      concerns: [],
      escalationLog: [],
    } as any,
    client: 'test',
    parentModel: null,
  };
}

function makeR1ViolatingContext(): BuildContext {
  const ctx = makeHealthyContext();
  // R1: terminalStatus=ok requires workerStatus done|done_with_concerns,
  // but workerSelfAssessment 'blocked' produces workerStatus=blocked
  // while terminationReason.cause='finished' produces terminalStatus=ok.
  (ctx.runResult.terminationReason as any).workerSelfAssessment = 'blocked';
  return ctx;
}

describe('Item 13: validation_warnings attached to event', () => {
  it('R1 violation event ships with validation_warnings populated', async () => {
    const dir = makeTempDir();
    const recorder = createRecorder({ homeDir: dir, mmagentVersion: '0.0.0-test' });

    const ctx = makeR1ViolatingContext();
    recorder.recordTaskCompleted(ctx);

    const enqueued = await readEnqueuedEvent(dir);

    expect(enqueued.validation_warnings).toBeDefined();
    expect(
      (enqueued.validation_warnings as any[]).some((w) => w.rule.startsWith('R1:')),
    ).toBe(true);
  });

  it('healthy event has validation_warnings absent', async () => {
    const dir = makeTempDir();
    const recorder = createRecorder({ homeDir: dir, mmagentVersion: '0.0.0-test' });

    const ctx = makeHealthyContext();
    recorder.recordTaskCompleted(ctx);

    const enqueued = await readEnqueuedEvent(dir);

    expect(enqueued.validation_warnings).toBeUndefined();
  });
});
