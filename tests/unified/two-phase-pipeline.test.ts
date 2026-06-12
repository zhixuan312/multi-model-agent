import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { WorktreeManager } from '../../packages/core/src/unified/worktree-manager.js';

vi.mock('../../packages/core/src/unified/worktree-manager.js', () => {
  const WorktreeManager = vi.fn();
  WorktreeManager.prototype.create = vi.fn();
  WorktreeManager.prototype.cleanup = vi.fn();
  return { WorktreeManager };
});

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
    });

    expect(result.status).toBe('done');
    expect(result.sessions.implementer.sessionId).toBe('sess-mock');
    expect(result.sessions.implementer.tier).toBe('standard');
    expect(result.sessions.reviewer?.sessionId).toBe('sess-mock');
    expect(result.sessions.reviewer?.tier).toBe('complex');
    expect(result.reviewerOutput?.verdict).toBe('approved');
    expect(result.worktree).toBeNull();
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
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'read-only',
    });

    expect(result.status).toBe('done');
    expect(result.sessions.reviewer).toBeNull();
    expect(result.reviewerOutput).toBeNull();
    expect(result.worktree).toBeNull();
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
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp',
      sandboxPolicy: 'cwd-only',
    });

    expect(result.status).toBe('done_with_concerns');
    expect(result.reviewerParseError).toBeTruthy();
    expect(result.worktree).toBeNull();
  });

  it('creates worktree when worktreeEnabled=true and cleans up', async () => {
    const createMock = vi.mocked(WorktreeManager.prototype.create);
    const cleanupMock = vi.mocked(WorktreeManager.prototype.cleanup);

    createMock.mockResolvedValue({
      branch: 'mma/delegate-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
    });
    // cleanup returns true = preserved (has changes)
    cleanupMock.mockResolvedValue(true);

    const impl = mockSession('{"tasksCompleted":["x"],"filesChanged":[],"notes":"done"}');
    const rev = mockSession('{"findings":[],"summary":"clean","verdict":"approved"}');

    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'do X',
      implementerProvider: implProvider,
      reviewerProvider: revProvider,
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
      worktreeEnabled: true,
      taskId: 'abcd1234-5678-9abc-def0-1234567890ab',
    });

    // Worktree was created with the worktree path
    expect(createMock).toHaveBeenCalledWith('/tmp/test', 'abcd1234-5678-9abc-def0-1234567890ab', 'delegate');

    // Sessions opened with worktree cwd, not original cwd
    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test/.mma/worktrees/abcd1234' }),
    );
    expect(revProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test/.mma/worktrees/abcd1234' }),
    );

    // Cleanup was called
    expect(cleanupMock).toHaveBeenCalledWith(
      '/tmp/test/.mma/worktrees/abcd1234',
      'mma/delegate-abcd1234',
    );

    // Result includes worktree info
    expect(result.worktree).toEqual({
      branch: 'mma/delegate-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: true,
    });

    expect(result.status).toBe('done');
  });

  it('returns worktree=null when worktreeEnabled=false', async () => {
    const createMock = vi.mocked(WorktreeManager.prototype.create);

    const impl = mockSession('{"tasksCompleted":["x"],"filesChanged":[],"notes":"done"}');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'do X',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
      worktreeEnabled: false,
      taskId: 'test-id',
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(result.worktree).toBeNull();
  });

  it('creates worktree with reviewPolicy=none and cleans up', async () => {
    const createMock = vi.mocked(WorktreeManager.prototype.create);
    const cleanupMock = vi.mocked(WorktreeManager.prototype.cleanup);

    createMock.mockResolvedValue({
      branch: 'mma/audit-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
    });
    // cleanup returns false = removed (no changes)
    cleanupMock.mockResolvedValue(false);

    const impl = mockSession('done');

    const result = await runTwoPhasePipeline({
      type: 'audit',
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'audit',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'read-only',
      worktreeEnabled: true,
      taskId: 'abcd1234-0000-0000-0000-000000000000',
    });

    expect(createMock).toHaveBeenCalled();
    expect(cleanupMock).toHaveBeenCalled();
    expect(result.worktree).toEqual({
      branch: 'mma/audit-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
    });
  });
});
