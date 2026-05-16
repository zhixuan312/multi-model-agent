// tests/fixtures/lifecycle-state.ts
// Shared mock builders consumed by every handler test in this migration.
// Keep these minimal: enough to satisfy the handler being tested.
import type {
  LifecycleState, StageGate, StageStopReason, RouteName,
  ImplementPayload, ReviewPayload, ReworkPayload, CommitPayload,
  AnnotatePayload, Finding,
} from '../../packages/core/src/lifecycle/stage-io.js';

export function zeroTel(label = '', stopReason: StageStopReason = 'normal') {
  return { stageLabel: label, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason };
}

export function advanceGate<T>(payload: T, opts: Partial<StageGate<T>['telemetry']> = {}): StageGate<T> {
  return { outcome: 'advance', payload, telemetry: { ...zeroTel(), ...opts } };
}
export function skipGate(comment: string): StageGate<null> {
  return { outcome: 'skip', payload: null, comment, telemetry: zeroTel() };
}
export function haltGate(comment: string, stageLabel = 'implement'): StageGate<null> {
  return { outcome: 'halt', payload: null, comment, telemetry: zeroTel(stageLabel, 'transport_error') };
}

/** Minimal LifecycleState — fills only the slots the unit tests need; anything else is overridden in opts. */
export function mockState(opts: Partial<LifecycleState> & { route?: RouteName; gates?: Record<string, StageGate<unknown>>; halted?: boolean } = {}): LifecycleState {
  return {
    route: 'delegate',
    task: { id: 't1', brief: { title: 'T', body: 'B' } } as any,
    config: { reviewPolicy: 'standard', autoCommit: true, sandboxPolicy: 'cwd-only', timeoutMs: 60_000, maxCostUSD: 1 } as any,
    request: {} as any,
    cwd: '/tmp/fake',
    preTaskHeadSha: 'aaaaaaa',
    projectContext: { contextBlocks: { register: (_c: string) => ({ id: 'cb-1' }) } } as any,
    executionContext: makeFakeExecutionContext(),
    batchId: 'batch1',
    taskIndex: 0,
    gates: {},
    halted: false,
    terminalFlags: undefined as any,
    ...opts,
  } as LifecycleState;
}

/** Convenience builder for review-handler tests. Returns state with mocked sub-reviewer turn outputs. */
export function mockReviewState(opts: { specOutput?: string; qualityOutput?: string }): LifecycleState {
  const state = mockState({ route: 'delegate' });
  state.gates['implement'] = advanceGate({
    workerSelfAssessment: 'done', summary: 'did it',
    filesChanged: ['x.ts'], findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
  } as ImplementPayload);
  // Stub the reviewer runner so each sub-reviewer returns the canned text.
  (state.executionContext as any).__mockReviewerOutputs = {
    spec: opts.specOutput, quality: opts.qualityOutput,
  };
  return state;
}

export function mockReworkState(opts: {
  reviewFindings?: Finding[]; workerOutput?: Partial<ReworkPayload>;
}): LifecycleState {
  const state = mockState({ route: 'delegate' });
  state.gates['implement'] = advanceGate({
    workerSelfAssessment: 'done', summary: 'initial', filesChanged: ['a.ts'],
    findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
  } as ImplementPayload);
  state.gates['review'] = advanceGate({
    verdict: 'changes_required',
    findings: opts.reviewFindings ?? [],
    reviewersSucceeded: ['spec', 'quality'], reviewersErrored: [],
  } as ReviewPayload);
  (state.executionContext as any).__mockWorkerStructuredOutput = opts.workerOutput;
  return state;
}

export function mockCommitState(opts: {
  hasDiff?: boolean; hooksPass?: boolean; noRepo?: boolean; detachedHead?: boolean;
}): LifecycleState {
  const state = mockState({ route: 'delegate' });
  state.gates['implement'] = advanceGate({
    workerSelfAssessment: 'done', summary: 's', filesChanged: ['a.ts'],
    findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
  } as ImplementPayload);
  (state.executionContext as any).__mockGit = {
    hasRepo: !opts.noRepo,
    currentBranch: opts.detachedHead ? null : 'main',
    diffFiles: opts.hasDiff === false ? [] : ['a.ts'],
    hooksPass: opts.hooksPass !== false,
  };
  return state;
}

export function mockTerminalState(opts: {
  failTelemetryFlush?: boolean; failBatchRegistry?: boolean;
}): LifecycleState {
  const state = mockState({ route: 'delegate' });
  state.gates['compose'] = advanceGate({
    completed: true, message: 'ok', findings: [], summary: 's',
    filesChanged: ['a.ts'], commitSha: 'abc', blockId: null,
    telemetry: { totalDurationMs: 0, totalCostUSD: null,
      workerSelfAssessment: 'done', reviewVerdict: 'approved',
      commitOutcome: 'committed', stopReason: 'normal',
      haltedStage: null, stages: [],
    },
  });
  const ctx = state.executionContext as any;
  ctx.__failFlags = { telemetryFlush: !!opts.failTelemetryFlush, batchRegistry: !!opts.failBatchRegistry };
  return state;
}

export function mockAnnotateState(opts: { llmAlwaysFails?: boolean; route?: RouteName }): LifecycleState {
  const state = mockState({ route: opts.route ?? 'delegate' });
  state.gates['implement'] = advanceGate({
    workerSelfAssessment: 'done', summary: 's', filesChanged: ['a.ts'],
    findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
  } as ImplementPayload);
  // Annotator-precondition-satisfying defaults: tests focused on truncation/
  // dedupe/severity shouldn't get tripped by the parser flipping completed=false.
  (state as any).reviewVerdict = 'approved';
  (state as any).reviewPolicy = 'full';
  (state as any).commits = [{ sha: 'abc', subject: 's', body: '', filesChanged: ['a.ts'], authoredAt: '2026-05-15T00:00:00Z' }];
  state.gates['commit'] = advanceGate({
    kind: 'committed', commitSha: 'abc', commitMessage: 's',
    filesChanged: ['a.ts'], authoredAt: '2026-05-15T00:00:00Z',
  } as any);
  (state.executionContext as any).__llmAlwaysFails = !!opts.llmAlwaysFails;
  return state;
}

/** Mock provider response shaped like the worker's structured JSON output. */
export function makeProviderResponseWithStructuredOutput(out: Partial<ImplementPayload>) {
  return {
    kind: 'ok',
    text: `Worker prose here.\n\`\`\`json\n${JSON.stringify({
      workerSelfAssessment: 'done', summary: '', filesChanged: [],
      findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      ...out,
    })}\n\`\`\``,
    stopReason: 'normal' as const,
    costUSD: 0.01, turnsUsed: 1,
  };
}

function makeFakeExecutionContext(): any {
  const ctx: any = {
    provider: { runTurn: async (..._a: unknown[]) => ({ kind: 'ok', text: '', costUSD: 0, turnsUsed: 0, stopReason: 'normal' }) },
    assignedTier: 'standard',
    providers: {
      standard: {
        name: 'mock-provider',
        config: { model: 'mock' },
        run: async (..._a: unknown[]) => ({ kind: 'ok', text: '', costUSD: 0, turnsUsed: 0, stopReason: 'normal' }),
      },
    },
    cwd: '/tmp/fake',
    stall: { controller: new AbortController() },
    timing: { timeoutMs: 60000, deadlineMs: Date.now() + 60000 },
    taskIndex: 0,
    config: { defaults: { progressWatchdogEnabled: false } },
    implementerProvider: { config: { model: 'mock' } },
    bus: { emit: (_e: unknown) => {} },
    recorder: { flush: async (..._a: unknown[]) => {} },
    stallController: { armed: false },
    contextBlockStore: {
      register: (_p: { id: string; content: string }) => { /* void */ },
    },
    batchRegistry: { persist: async (..._a: unknown[]) => {} },
    projectContext: {
      contextBlocks: { register: (c: string) => ({ id: 'cb-1' }), ttlMs: 24 * 60 * 60 * 1000 },
      cleanupTick: () => {},
    },
  };
  // Session mock — tests that exercise the annotator LLM judge layer flip
  // ctx.__llmAlwaysFails to force the transport-error fallback path. Default
  // session returns an empty-output ok turn, which makes the annotator's JSON
  // parse fail gracefully and the deterministic synthesis take over.
  ctx.getSession = (_tier: string) => ({
    send: async (_prompt: string, _opts?: { stageLabel?: string }) => {
      if (ctx.__llmAlwaysFails) {
        throw new Error('transport timeout (test fixture forced)');
      }
      if (ctx.__mockSessionResponse) {
        return ctx.__mockSessionResponse;
      }
      return { output: '', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, filesRead: [], filesWritten: [], toolCallsByName: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'finished' };
    },
    close: async () => {},
  });
  return ctx;
}