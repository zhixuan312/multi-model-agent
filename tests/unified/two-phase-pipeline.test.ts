import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { WorktreeManager } from '../../packages/core/src/unified/worktree-manager.js';

vi.mock('../../packages/core/src/unified/worktree-manager.js', () => {
  const WorktreeManager = vi.fn();
  WorktreeManager.prototype.create = vi.fn();
  WorktreeManager.prototype.mergeAndCleanup = vi.fn();
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
    const cleanupMock = vi.mocked(WorktreeManager.prototype.mergeAndCleanup);

    createMock.mockResolvedValue({
      branch: 'mma/delegate-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
      merged: false,
    });
    cleanupMock.mockResolvedValue({
      branch: 'mma/delegate-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: true,
      merged: true,
    });

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

    // Implementer runs in worktree cwd
    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test/.mma/worktrees/abcd1234' }),
    );
    // Reviewer runs in original cwd (doesn't need worktree file access,
    // avoids ENOENT if worktree dir is cleaned by OS during long runs)
    expect(revProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test' }),
    );

    // mergeAndCleanup was called with original cwd
    expect(cleanupMock).toHaveBeenCalledWith(
      '/tmp/test/.mma/worktrees/abcd1234',
      'mma/delegate-abcd1234',
      '/tmp/test',
    );

    // Result includes worktree info with merged=true
    expect(result.worktree).toEqual({
      branch: 'mma/delegate-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: true,
      merged: true,
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

  it('BUG REPRO: implementer prompt has original-cwd paths while session cwd is worktree', async () => {
    const createMock = vi.mocked(WorktreeManager.prototype.create);
    const cleanupMock = vi.mocked(WorktreeManager.prototype.mergeAndCleanup);

    const ORIGINAL_CWD = '/project/repo';
    const WORKTREE_CWD = '/project/repo/.mma/worktrees/abcd1234';

    createMock.mockResolvedValue({
      branch: 'mma/execute_plan-abcd1234',
      path: WORKTREE_CWD,
      hasChanges: false,
      merged: false,
    });
    cleanupMock.mockResolvedValue({
      branch: 'mma/execute_plan-abcd1234',
      path: WORKTREE_CWD,
      hasChanges: true,
      merged: true,
    });

    const impl = mockSession('{"stepsCompleted":["x"],"filesChanged":[],"workerSelfAssessment":"done"}');
    const rev = mockSession('{"findings":[],"summary":"clean","verdict":"approved"}');

    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);

    // Simulate execute_plan payload — filePaths use the ORIGINAL cwd
    const taskPayload = JSON.stringify({
      filePaths: [`${ORIGINAL_CWD}/docs/plans/my-plan.md`],
      taskDescriptors: ['## 1. Add validation'],
    }, null, 2);

    await runTwoPhasePipeline({
      type: 'execute_plan',
      implementerSkill: '# Execute Plan — Implementer\n\nImplement the task.',
      reviewerSkill: '# Review',
      taskPayload,
      implementerProvider: implProvider,
      reviewerProvider: revProvider,
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: ORIGINAL_CWD,
      sandboxPolicy: 'cwd-only',
      worktreeEnabled: true,
      taskId: 'abcd1234-5678-9abc-def0-1234567890ab',
    });

    // The session was opened with the WORKTREE cwd
    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: WORKTREE_CWD }),
    );

    // But the prompt sent to the implementer contains the ORIGINAL cwd path
    const implSendCall = impl.send.mock.calls[0];
    const promptSent = implSendCall[0] as string;

    // FIXED: The pipeline rewrites original-cwd paths to worktree paths
    // so the implementer sees only worktree paths in its prompt.
    const hasOriginalPath = promptSent.includes(`${ORIGINAL_CWD}/docs`);
    const hasWorktreePath = promptSent.includes(WORKTREE_CWD);

    expect(hasOriginalPath).toBe(false);  // original-cwd paths are rewritten
    expect(hasWorktreePath).toBe(true);   // prompt now references the worktree

    // Verify the rewritten path is correct
    expect(promptSent).toContain(`${WORKTREE_CWD}/docs/plans/my-plan.md`);
  });

  it('threads bus into both openSession calls', async () => {
    const impl = mockSession('{"tasksCompleted":["x"],"filesChanged":[],"notes":"done"}');
    const rev = mockSession('{"findings":[],"summary":"clean","verdict":"approved"}');
    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);
    const fakeBus = { emitPlainEntry: vi.fn() };

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
      bus: fakeBus,
    });

    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ bus: fakeBus }),
    );
    expect(revProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ bus: fakeBus }),
    );
  });

  it('threads bus into openSession for reviewPolicy=none', async () => {
    const impl = mockSession('done');
    const implProvider = mockProvider(impl);
    const fakeBus = { emitPlainEntry: vi.fn() };

    await runTwoPhasePipeline({
      type: 'audit',
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: implProvider,
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp',
      sandboxPolicy: 'read-only',
      bus: fakeBus,
    });

    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ bus: fakeBus }),
    );
  });

  it('creates worktree with reviewPolicy=none and cleans up', async () => {
    const createMock = vi.mocked(WorktreeManager.prototype.create);
    const cleanupMock = vi.mocked(WorktreeManager.prototype.mergeAndCleanup);

    createMock.mockResolvedValue({
      branch: 'mma/audit-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
      merged: false,
    });
    cleanupMock.mockResolvedValue({
      branch: 'mma/audit-abcd1234',
      path: '/tmp/test/.mma/worktrees/abcd1234',
      hasChanges: false,
      merged: false,
    });

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
      merged: false,
    });
  });
});
