import { describe, it, expect, vi } from 'vitest';
import { runTwoPhasePipeline } from '../../packages/core/src/unified/two-phase-pipeline.js';

vi.mock('../../packages/core/src/unified/worktree-manager.js', () => ({
  WorktreeManager: vi.fn(),
}));

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

const mockSession = (output: string, sessionId: string | null = null) => ({
  send: vi.fn().mockResolvedValue(mockTurn(output)),
  close: vi.fn(),
  getSessionId: vi.fn().mockReturnValue(sessionId),
});

describe('Session resume', () => {
  it('passes resumeImplementer to implementer openSession', async () => {
    const openSession = vi.fn().mockReturnValue(
      mockSession('{"status":"done","notes":"ok"}', 'sess-resumed'),
    );
    const provider = { name: 'mock', config: {}, openSession };
    const revProvider = {
      name: 'mock',
      config: {},
      openSession: vi.fn().mockReturnValue(
        mockSession('{"findings":[],"summary":"ok","verdict":"approved"}'),
      ),
    };

    await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: provider,
      reviewerProvider: revProvider,
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp',
      sandboxPolicy: 'cwd-only',
      resumeImplementer: 'sess-prior-123',
    });

    const opts = openSession.mock.calls[0][0];
    expect(opts).toHaveProperty('cwd', '/tmp');
    expect(opts).toHaveProperty('resume', 'sess-prior-123');
  });

  it('passes resumeReviewer to reviewer openSession', async () => {
    const implProvider = {
      name: 'mock', config: {},
      openSession: vi.fn().mockReturnValue(
        mockSession('{"status":"done","notes":"ok"}'),
      ),
    };
    const revOpenSession = vi.fn().mockReturnValue(
      mockSession('{"findings":[],"summary":"ok","verdict":"approved"}', 'rev-resumed'),
    );
    const revProvider = { name: 'mock', config: {}, openSession: revOpenSession };

    await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: implProvider,
      reviewerProvider: revProvider,
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp',
      sandboxPolicy: 'cwd-only',
      resumeReviewer: 'rev-prior-456',
    });

    const revOpts = revOpenSession.mock.calls[0][0];
    expect(revOpts).toHaveProperty('resume', 'rev-prior-456');
  });

  it('returns session IDs from both providers', async () => {
    const implSession = mockSession(
      '{"status":"done","notes":"ok"}',
      'impl-sess-id',
    );
    const revSession = mockSession(
      '{"findings":[],"summary":"ok","verdict":"approved"}',
      'rev-sess-id',
    );

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: {
        name: 'mock',
        config: {},
        openSession: vi.fn().mockReturnValue(implSession),
      },
      reviewerProvider: {
        name: 'mock',
        config: {},
        openSession: vi.fn().mockReturnValue(revSession),
      },
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp',
      sandboxPolicy: 'cwd-only',
    });

    expect(result.sessions.implementer.sessionId).toBe('impl-sess-id');
    expect(result.sessions.implementer.resumeSupported).toBe(true);
    expect(result.sessions.reviewer?.sessionId).toBe('rev-sess-id');
    expect(result.sessions.reviewer?.resumeSupported).toBe(true);
  });

  it('reports resumeSupported=false when provider returns null sessionId', async () => {
    const implSession = mockSession(
      '{"status":"done","notes":"ok"}',
      null,
    );

    const result = await runTwoPhasePipeline({
      type: 'audit',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: {
        name: 'mock',
        config: {},
        openSession: vi.fn().mockReturnValue(implSession),
      },
      reviewerProvider: {
        name: 'mock',
        config: {},
        openSession: vi.fn().mockReturnValue(mockSession('')),
      },
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp',
      sandboxPolicy: 'read-only',
    });

    expect(result.sessions.implementer.sessionId).toBeNull();
    expect(result.sessions.implementer.resumeSupported).toBe(false);
  });
});
