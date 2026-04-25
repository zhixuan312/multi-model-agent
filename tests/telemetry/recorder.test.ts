import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const homeDir = '/tmp/mma-recorder-test';

const {
  decideMock,
  getOrCreateInstallIdMock,
  buildInstallMetaMock,
  readGenerationMock,
  queueAppendMock,
  buildTaskCompletedEventMock,
  buildSessionStartedEventMock,
  buildInstallChangedEventMock,
  buildSkillInstalledEventMock,
} = vi.hoisted(() => ({
  decideMock: vi.fn(),
  getOrCreateInstallIdMock: vi.fn(),
  buildInstallMetaMock: vi.fn(),
  readGenerationMock: vi.fn(),
  queueAppendMock: vi.fn(),
  buildTaskCompletedEventMock: vi.fn(),
  buildSessionStartedEventMock: vi.fn(),
  buildInstallChangedEventMock: vi.fn(),
  buildSkillInstalledEventMock: vi.fn(),
}));

vi.mock('../../packages/server/src/telemetry/consent.js', () => ({
  decide: decideMock,
}));

vi.mock('../../packages/server/src/telemetry/install-id.js', () => ({
  getOrCreateInstallId: getOrCreateInstallIdMock,
}));

vi.mock('../../packages/server/src/telemetry/install-meta.js', () => ({
  buildInstallMeta: buildInstallMetaMock,
}));

vi.mock('../../packages/server/src/telemetry/generation.js', () => ({
  readGeneration: readGenerationMock,
}));

vi.mock('../../packages/server/src/telemetry/queue.js', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    append: queueAppendMock,
  })),
}));

vi.mock('@zhixuan92/multi-model-agent-core/telemetry/event-builder', () => ({
  buildTaskCompletedEvent: buildTaskCompletedEventMock,
  buildSessionStartedEvent: buildSessionStartedEventMock,
  buildInstallChangedEvent: buildInstallChangedEventMock,
  buildSkillInstalledEvent: buildSkillInstalledEventMock,
}));

import { createRecorder } from '../../packages/server/src/telemetry/recorder.js';

describe('recorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: consent enabled
    decideMock.mockReturnValue({ enabled: true, source: 'config' });
    getOrCreateInstallIdMock.mockReturnValue('00000000-0000-0000-0000-000000000001');
    buildInstallMetaMock.mockReturnValue({
      installId: '00000000-0000-0000-0000-000000000001',
      mmagentVersion: '3.6.0',
      os: 'darwin',
      nodeMajor: '22',
      language: 'en',
      tzOffsetBucket: 'utc_plus_6_to_plus_12',
    });
    readGenerationMock.mockReturnValue(0);
    queueAppendMock.mockResolvedValue(undefined);
    buildTaskCompletedEventMock.mockReturnValue({ type: 'task.completed', eventId: 'ev-1' });
    buildSessionStartedEventMock.mockReturnValue({ type: 'session.started', eventId: 'ev-2' });
    buildInstallChangedEventMock.mockReturnValue({ type: 'install.changed', eventId: 'ev-3' });
    buildSkillInstalledEventMock.mockReturnValue({ type: 'skill.installed', eventId: 'ev-4' });
  });

  // ── opt-out ─────────────────────────────────────────────────────────

  it('opt-out → no install-id created; no events queued', async () => {
    decideMock.mockReturnValue({ enabled: false, source: 'config' });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null });
    r.recordSessionStarted({ defaultTier: 'standard', diagnosticsEnabled: false, autoUpdateSkills: false, providersConfigured: [] });
    r.recordInstallChanged(null, '3.6.0', 'fresh_install');
    r.recordSkillInstalled('mma-delegate', 'claude-code');

    // Let any fire-and-forget promises settle
    await vi.waitFor(() => expect(queueAppendMock).not.toHaveBeenCalled());

    expect(getOrCreateInstallIdMock).not.toHaveBeenCalled();
    expect(buildInstallMetaMock).not.toHaveBeenCalled();
    expect(buildTaskCompletedEventMock).not.toHaveBeenCalled();
    expect(buildSessionStartedEventMock).not.toHaveBeenCalled();
    expect(buildInstallChangedEventMock).not.toHaveBeenCalled();
    expect(buildSkillInstalledEventMock).not.toHaveBeenCalled();
    expect(queueAppendMock).not.toHaveBeenCalled();
  });

  // ── opt-in + lazy install-id ───────────────────────────────────────

  it('opt-in → install-id created on first event; install metadata captured at event time', () => {
    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    // First call: should resolve install-id
    r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null });

    expect(getOrCreateInstallIdMock).toHaveBeenCalledTimes(1);
    expect(buildInstallMetaMock).toHaveBeenCalledTimes(1);
    expect(buildInstallMetaMock).toHaveBeenCalledWith({
      installId: '00000000-0000-0000-0000-000000000001',
      mmagentVersion: '3.6.0',
    });

    // Second call: install-id should be cached (no second getOrCreateInstallId call)
    r.recordSessionStarted({ defaultTier: 'standard', diagnosticsEnabled: false, autoUpdateSkills: false, providersConfigured: [] });

    expect(getOrCreateInstallIdMock).toHaveBeenCalledTimes(1);
    expect(buildInstallMetaMock).toHaveBeenCalledTimes(2);
  });

  // ── recordTaskCompleted ────────────────────────────────────────────

  it('recordTaskCompleted enqueues a valid TaskCompletedEvent', () => {
    const ctx = {
      route: 'delegate' as const,
      taskSpec: { filePaths: ['a.ts'] },
      runResult: { terminationReason: { cause: 'finished' } } as any,
      client: 'claude-code' as const,
      triggeringSkill: 'mma-delegate' as const,
      parentModel: null,
    };
    buildTaskCompletedEventMock.mockReturnValue({ type: 'task.completed', eventId: 'task-1' });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });
    r.recordTaskCompleted(ctx);

    expect(buildTaskCompletedEventMock).toHaveBeenCalledWith(ctx);
    expect(queueAppendMock).toHaveBeenCalledTimes(1);

    const record = queueAppendMock.mock.calls[0][0];
    expect(record.schemaVersion).toBe(1);
    expect(record.event).toEqual({ type: 'task.completed', eventId: 'task-1' });
    expect(record.install.installId).toBe('00000000-0000-0000-0000-000000000001');
    expect(record.generation).toBe(0);
  });

  // ── recordSkillInstalled ───────────────────────────────────────────

  it('recordSkillInstalled enqueues a SkillInstalledEvent', () => {
    buildSkillInstalledEventMock.mockReturnValue({ type: 'skill.installed', eventId: 'skill-1' });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });
    r.recordSkillInstalled('mma-delegate', 'claude-code');

    expect(buildSkillInstalledEventMock).toHaveBeenCalledWith('mma-delegate', 'claude-code');
    expect(queueAppendMock).toHaveBeenCalledTimes(1);

    const record = queueAppendMock.mock.calls[0][0];
    expect(record.event).toEqual({ type: 'skill.installed', eventId: 'skill-1' });
  });

  // ── recordSessionStarted ───────────────────────────────────────────

  it('recordSessionStarted enqueues a SessionStartedEvent', () => {
    const snap = {
      defaultTier: 'standard' as const,
      diagnosticsEnabled: true,
      autoUpdateSkills: false,
      providersConfigured: ['claude' as const],
    };
    buildSessionStartedEventMock.mockReturnValue({ type: 'session.started', eventId: 'sess-1' });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });
    r.recordSessionStarted(snap);

    expect(buildSessionStartedEventMock).toHaveBeenCalledWith(snap);
    expect(queueAppendMock).toHaveBeenCalledTimes(1);
  });

  // ── recordInstallChanged ───────────────────────────────────────────

  it('recordInstallChanged enqueues an InstallChangedEvent', () => {
    buildInstallChangedEventMock.mockReturnValue({ type: 'install.changed', eventId: 'inst-1' });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });
    r.recordInstallChanged(null, '3.6.0', 'fresh_install');

    expect(buildInstallChangedEventMock).toHaveBeenCalledWith(null, '3.6.0', 'fresh_install');
    expect(queueAppendMock).toHaveBeenCalledTimes(1);
  });

  // ── error paths (bedrock invariant) ────────────────────────────────

  it('every error path returns silently — consent throws', () => {
    decideMock.mockImplementation(() => { throw new Error('consent boom'); });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    // None of these should throw
    expect(() => r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null })).not.toThrow();
    expect(() => r.recordSessionStarted({ defaultTier: 'standard', diagnosticsEnabled: false, autoUpdateSkills: false, providersConfigured: [] })).not.toThrow();
    expect(() => r.recordInstallChanged(null, '3.6.0', 'fresh_install')).not.toThrow();
    expect(() => r.recordSkillInstalled('mma-delegate', 'claude-code')).not.toThrow();

    expect(queueAppendMock).not.toHaveBeenCalled();
  });

  it('every error path returns silently — builder throws', () => {
    buildTaskCompletedEventMock.mockImplementation(() => { throw new Error('builder boom'); });
    buildSessionStartedEventMock.mockImplementation(() => { throw new Error('builder boom'); });
    buildInstallChangedEventMock.mockImplementation(() => { throw new Error('builder boom'); });
    buildSkillInstalledEventMock.mockImplementation(() => { throw new Error('builder boom'); });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    expect(() => r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null })).not.toThrow();
    expect(() => r.recordSessionStarted({ defaultTier: 'standard', diagnosticsEnabled: false, autoUpdateSkills: false, providersConfigured: [] })).not.toThrow();
    expect(() => r.recordInstallChanged(null, '3.6.0', 'fresh_install')).not.toThrow();
    expect(() => r.recordSkillInstalled('mma-delegate', 'claude-code')).not.toThrow();

    expect(queueAppendMock).not.toHaveBeenCalled();
  });

  it('every error path returns silently — queue.append rejects', async () => {
    queueAppendMock.mockRejectedValue(new Error('queue boom'));

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    expect(() => r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null })).not.toThrow();

    // Let the fire-and-forget rejection settle
    await vi.waitFor(() => expect(queueAppendMock).toHaveBeenCalled());
  });

  it('every error path returns silently — install-meta/buildInstallMeta throws', () => {
    buildInstallMetaMock.mockImplementation(() => { throw new Error('meta boom'); });

    const r = createRecorder({ homeDir, mmagentVersion: '3.6.0' });

    expect(() => r.recordTaskCompleted({ route: 'delegate', taskSpec: {}, runResult: {} as any, client: 'claude-code', triggeringSkill: 'direct', parentModel: null })).not.toThrow();

    expect(queueAppendMock).not.toHaveBeenCalled();
    // getOrCreateInstallId was called before buildInstallMeta threw
    expect(getOrCreateInstallIdMock).toHaveBeenCalledTimes(1);
  });
});
