import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { captureBaseline, commitAll } from '../../packages/core/src/unified/repo-commit.js';

// The engine commits in the caller's checkout — no worktree, no branch, no merge.
vi.mock('../../packages/core/src/unified/repo-commit.js', () => ({
  captureBaseline: vi.fn().mockResolvedValue({ head: 'base0', branch: 'mma/2026-07-31-x', dirtyAtDispatch: false }),
  assertRepoUntampered: vi.fn().mockResolvedValue(undefined),
  commitAll: vi.fn().mockResolvedValue({ committed: true, head: 'new1', filesChanged: ['a.ts'] }),
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
  toolCalls: [],
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
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"reviewed"}');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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
    const revData = result.reviewerOutput as { status: string } | null;
    expect(revData?.status).toBe('done');
    expect(result.worktree).toBeNull();
    expect(impl.send).toHaveBeenCalledOnce();
    expect(rev.send).toHaveBeenCalledOnce();
  });

  it('skips reviewer when reviewPolicy=none', async () => {
    const impl = mockSession('{"status":"done","notes":"done"}');

    const result = await runTwoPhasePipeline({
      type: 'audit',
      readerFacing: true,
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

  it('reviewer receives implementer output + Original Task, and final output is reviewer version', async () => {
    const implFindings = JSON.stringify({
      criteriaCovered: ['requirement-testability'],
      findings: [{ weight: 'high', category: 'requirement-testability', claim: 'impl found this', evidence: 'spec says X', suggestion: 'fix X' }],
    });
    const revFindings = JSON.stringify({
      criteriaCovered: ['requirement-testability', 'scope-explicitness-and-decomposability'],
      findings: [
        { weight: 'high', category: 'requirement-testability', claim: 'impl found this', evidence: 'spec says X', suggestion: 'fix X' },
        { weight: 'medium', category: 'scope-explicitness-and-decomposability', claim: 'reviewer added this', evidence: 'section 2', suggestion: 'clarify scope' },
      ],
    });

    const impl = mockSession(`\`\`\`json\n${implFindings}\n\`\`\``);
    const rev = mockSession(`\`\`\`json\n${revFindings}\n\`\`\``);

    const taskPayload = '{"target":{"paths":["/project/spec.md"]},"subtype":"spec"}';

    const result = await runTwoPhasePipeline({
      type: 'audit',
      readerFacing: true,
      implementerSkill: '# Audit Implement',
      reviewerSkill: '# Audit Review',
      taskPayload,
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(rev),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'reviewed',
      cwd: '/project',
      sandboxPolicy: 'read-only',
    });

    // 1. Implementer received the skill + task payload
    const implPrompt = impl.send.mock.calls[0][0] as string;
    expect(implPrompt).toContain('# Audit Implement');
    expect(implPrompt).toContain('spec.md');

    // 2. Reviewer received: skill + Original Task + implementer output
    const revPrompt = rev.send.mock.calls[0][0] as string;
    expect(revPrompt).toContain('# Audit Review');
    expect(revPrompt).toContain('## Original Task');
    expect(revPrompt).toContain('spec.md');
    expect(revPrompt).toContain('## Implementer Output');
    expect(revPrompt).toContain('impl found this');

    // 3. Final output is the REVIEWER's version (2 findings, not 1)
    expect(result.status).toBe('done');
    const final = result.reviewerOutput as { findings: { claim: string }[] };
    expect(final.findings).toHaveLength(2);
    expect(final.findings[0].claim).toBe('impl found this');
    expect(final.findings[1].claim).toBe('reviewer added this');
  });

  it('calls onPhaseChange with implementing then reviewing', async () => {
    const phases: string[] = [];
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"ok"}');

    await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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
      onPhaseChange: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(['implementing', 'reviewing']);
  });

  it('calls onPhaseChange with implementing only when reviewPolicy=none', async () => {
    const phases: string[] = [];
    const impl = mockSession('done');

    await runTwoPhasePipeline({
      type: 'audit',
      readerFacing: true,
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: mockProvider(impl),
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp',
      sandboxPolicy: 'read-only',
      onPhaseChange: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(['implementing']);
  });

  it('returns done_with_concerns on unparseable reviewer output', async () => {
    const impl = mockSession('implemented');
    const rev = mockSession('Looks good, no issues.');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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

  it('runs in the CALLER cwd and commits there — no worktree, no branch', async () => {
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"reviewed"}');
    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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
      writeRoute: true,
      taskId: 'abcd1234-5678-9abc-def0-1234567890ab',
    });

    // The baseline is captured against the caller's own checkout.
    expect(captureBaseline).toHaveBeenCalledWith('/tmp/test');

    // BOTH phases run in the caller's cwd — there is no second directory any more.
    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test', disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'] }),
    );
    expect(revProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/test', disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'] }),
    );

    // The engine commits once, in the caller's cwd.
    expect(commitAll).toHaveBeenCalledOnce();
    expect(vi.mocked(commitAll).mock.calls[0]![0]).toBe('/tmp/test');

    // Response-compatibility key stays present and permanently null.
    expect(result.worktree).toBeNull();
    expect(result.filesChangedFromGit).toEqual(['a.ts']);
    // SPEC-003 B6 defect 2 — the commit-time SHA is carried on the result, exactly what
    // `commitAll()` reported at the instant it committed.
    expect(result.commitSha).toBe('new1');
    expect(result.status).toBe('done');
  });

  it('commitSha is null when the write route committed nothing (no drift with an unrelated pre-existing HEAD)', async () => {
    vi.mocked(commitAll).mockResolvedValueOnce({ committed: false, head: 'base0', filesChanged: [] });
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"reviewed"}');

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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
      writeRoute: true,
      taskId: 'test-id',
    });

    // `commitAll()` still reports a `head` (the unchanged baseline) even when nothing was
    // committed — `commitSha` must not be conflated with that pre-existing HEAD.
    expect(result.filesChangedFromGit).toEqual([]);
    expect(result.commitSha).toBeNull();
  });

  it('surfaces dirtyAtDispatch so a swept-in pre-existing change is visible', async () => {
    vi.mocked(captureBaseline).mockResolvedValueOnce({ head: 'base0', branch: 'mma/x', dirtyAtDispatch: true, statusText: ' M src/a.ts' });

    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'do X',
      implementerProvider: mockProvider(mockSession('{"status":"done"}')),
      reviewerProvider: mockProvider(mockSession('{"status":"done"}')),
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
      writeRoute: true,
      taskId: 'test-id',
    });

    expect(result.dirtyAtDispatch).toBe(true);
  });

  it('does not touch git for a read route', async () => {
    const result = await runTwoPhasePipeline({
      type: 'investigate',
      readerFacing: true,
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'look at X',
      implementerProvider: mockProvider(mockSession('{"status":"done"}')),
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'complex',
      reviewerTier: 'complex',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'read-only',
      writeRoute: false,
      taskId: 'test-id',
    });

    expect(captureBaseline).not.toHaveBeenCalled();
    expect(commitAll).not.toHaveBeenCalled();
    expect(result.worktree).toBeNull();
    expect(result.filesChangedFromGit).toBeNull();
    expect(result.commitSha).toBeNull();
    expect(result.dirtyAtDispatch).toBe(false);
  });

  it('does NOT rewrite cwd paths in the payload — the worker cwd IS the caller cwd', async () => {
    // The old pipeline string-replaced the cwd throughout the payload so worker paths pointed
    // into the worktree. That substitution was blind (it would corrupt any incidental
    // occurrence of the cwd string) and is now unnecessary: there is only one directory.
    const CWD = '/project/repo';
    const impl = mockSession('{"tasks":[{"id":"I-1","status":"done"}],"notes":"done"}');
    const implProvider = mockProvider(impl);

    const taskPayload = JSON.stringify({
      target: { paths: [`${CWD}/docs/plans/my-plan.md`] },
      tasks: ['## 1. Add validation'],
    }, null, 2);

    await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload,
      implementerProvider: implProvider,
      reviewerProvider: mockProvider(mockSession('{"status":"done"}')),
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'none',
      cwd: CWD,
      sandboxPolicy: 'cwd-only',
      writeRoute: true,
      taskId: 'abcd1234-5678-9abc-def0-1234567890ab',
    });

    expect(implProvider.openSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: CWD }));

    const promptSent = impl.send.mock.calls[0]![0] as string;
    // The path survives verbatim — no rewriting, no corruption.
    expect(promptSent).toContain(`${CWD}/docs/plans/my-plan.md`);
    // And the worker is told git is off-limits.
    expect(promptSent).toContain('Do NOT run git');
  });

  it('threads bus into both openSession calls', async () => {
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"reviewed"}');
    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);
    const fakeBus = { emitPlainEntry: vi.fn() };

    await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
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

  it('passes sandboxPolicy=read-only into openSession for read tasks', async () => {
    const impl = mockSession('{"findings":[],"summary":"clean"}');
    const implProvider = mockProvider(impl);

    await runTwoPhasePipeline({
      type: 'audit',
      readerFacing: true,
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'audit doc',
      implementerProvider: implProvider,
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'read-only',
    });

    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPolicy: 'read-only' }),
    );
  });

  it('passes sandboxPolicy=cwd-only + disallowedTools into openSession for write tasks', async () => {
    const impl = mockSession('{"status":"done","notes":"done"}');
    const rev = mockSession('{"status":"done","notes":"reviewed"}');
    const implProvider = mockProvider(impl);
    const revProvider = mockProvider(rev);

    await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
      implementerSkill: '#',
      reviewerSkill: '#',
      taskPayload: 'x',
      implementerProvider: implProvider,
      reviewerProvider: revProvider,
      implementerTier: 'standard',
      reviewerTier: 'complex',
      reviewPolicy: 'reviewed',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
    });

    expect(implProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxPolicy: 'cwd-only',
        disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
      }),
    );
    expect(revProvider.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxPolicy: 'cwd-only',
        disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
      }),
    );
  });

  it('threads bus into openSession for reviewPolicy=none', async () => {
    const impl = mockSession('done');
    const implProvider = mockProvider(impl);
    const fakeBus = { emitPlainEntry: vi.fn() };

    await runTwoPhasePipeline({
      type: 'audit',
      readerFacing: true,
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

  it('commits on the review-skipped path too (reviewPolicy=none)', async () => {
    const result = await runTwoPhasePipeline({
      type: 'delegate',
      readerFacing: false,
      implementerSkill: '# Implement',
      reviewerSkill: '# Review',
      taskPayload: 'do X',
      implementerProvider: mockProvider(mockSession('{"status":"done"}')),
      reviewerProvider: mockProvider(mockSession('')),
      implementerTier: 'standard',
      reviewerTier: 'standard',
      reviewPolicy: 'none',
      cwd: '/tmp/test',
      sandboxPolicy: 'cwd-only',
      writeRoute: true,
      taskId: 'abcd1234-0000-0000-0000-000000000000',
    });

    expect(commitAll).toHaveBeenCalledOnce();
    expect(result.worktree).toBeNull();
    expect(result.filesChangedFromGit).toEqual(['a.ts']);
    expect(result.status).toBe('done');
  });
});
