import { describe, it, expect, vi } from 'vitest';
import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';

const mockTurn = (output: string) => ({
  output,
  usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0.01,
  turns: 1,
  durationMs: 1000,
  terminationReason: 'ok' as const,
  filesWritten: [],
  usedShell: false,
});

const mockSession = (output: string) => ({
  send: vi.fn().mockResolvedValue(mockTurn(output)),
  close: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue('sess-mock'),
});

const mockProvider = (session: ReturnType<typeof mockSession>) => ({
  name: 'mock',
  config: {},
  openSession: vi.fn().mockReturnValue(session),
});

describe('runTwoPhasePipeline', () => {
  it('runs both phases when reviewPolicy=reviewed', async () => {
    const impl = mockSession('{"tasksCompleted":["x"],"filesChanged":[],"notes":"done"}');
    const rev = mockSession('{"findings":[],"summary":"clean","verdict":"approved"}');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'do X',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(rev),
      reviewPolicy: 'reviewed',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
    });

    expect(result.status).toBe('done');
    expect(result.sessions.implementer.sessionId).toBe('sess-mock');
    expect(result.sessions.reviewer?.sessionId).toBe('sess-mock');
    expect(result.reviewerOutput?.verdict).toBe('approved');
    expect(impl.send).toHaveBeenCalledOnce();
    expect(rev.send).toHaveBeenCalledOnce();
  });

  it('skips reviewer when reviewPolicy=none', async () => {
    const impl = mockSession('{"tasksCompleted":["x"],"filesChanged":[],"notes":"done"}');

    const result = await runTwoPhasePipeline({
      type: 'audit',
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'audit doc',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(mockSession('')),
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'read-only',
    });

    expect(result.status).toBe('done');
    expect(result.sessions.reviewer).toBeNull();
    expect(result.reviewerOutput).toBeNull();
  });

  it('returns done_with_concerns on unparseable reviewer output', async () => {
    const impl = mockSession('implemented');
    const rev = mockSession('Looks good, no issues.');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(rev),
      reviewPolicy: 'reviewed',
      cwd: '/tmp',
      sandboxPolicy: 'cwd-only',
    });

    expect(result.status).toBe('done_with_concerns');
    expect(result.reviewerParseError).toBeTruthy();
  });
});
