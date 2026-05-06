import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reviewDiffHandler } from '../../../packages/core/src/lifecycle/handlers/review-diff-handler.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { Provider, RunResult, TaskSpec } from '../../../packages/core/src/types.js';
import type { VerifyStageResult } from '../../../packages/core/src/lifecycle/handlers/verify-stage.js';

const exec = promisify(execFile);

function makeState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    ...overrides,
  };
}

function makeCtx(cwd: string, providers: ExecutionContext['providers'] = {}, overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const base = {
    task: { prompt: 'x', tools: 'full', timeoutMs: 60_000 } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd,
    route: 'delegate',
    client: 'test',
    triggeringSkill: '',
    mainModel: null,
    assignedTier: 'standard' as const,
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers,
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full' as const,
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
  };
  return { ...base, ...overrides };
}

function mockProvider(reply: string, name: 'standard' | 'complex' = 'complex'): Provider {
  return {
    name,
    config: { type: 'claude', model: 'mock' } as Provider['config'],
    run: async () => ({
      output: reply,
      status: 'ok',
      usage: { inputTokens: 0, outputTokens: 0 },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      parsedFindings: null,
    } as RunResult),
  };
}

const passingVerify: VerifyStageResult = { status: 'passed', steps: [], totalDurationMs: 0 };

describe('reviewDiffHandler', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-handler-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await exec('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'first');
    await exec('git', ['add', 'a.txt'], { cwd: repoDir });
    await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'changed');
    await exec('git', ['add', 'a.txt'], { cwd: repoDir });
    await exec('git', ['commit', '-q', '-m', 'change'], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('skips when state.diffReviewVerdict is already set (idempotency)', async () => {
    const state = makeState({ diffReviewVerdict: 'approved' });
    await reviewDiffHandler(state);
    expect(state.diffReviewVerdict).toBe('approved');
  });

  it('no-ops when executionContext is missing', async () => {
    const state = makeState();
    await reviewDiffHandler(state);
    expect(state.diffReviewVerdict).toBeUndefined();
  });

  it('no-ops when verifyResult is missing', async () => {
    const state = makeState({ executionContext: makeCtx(repoDir) });
    await reviewDiffHandler(state);
    expect(state.diffReviewVerdict).toBeUndefined();
  });

  it("marks 'skipped' when reviewer provider is missing (runWithFallback bothUnavailable path)", async () => {
    const state = makeState({
      executionContext: makeCtx(repoDir, {}),
      verifyResult: passingVerify,
    });
    await reviewDiffHandler(state);
    // Step 7c: runWithFallback wraps the diff reviewer call; when neither
    // tier is configured, both are unavailable → handler records 'skipped'
    // (explicit) rather than leaving the slot undefined.
    expect(state.diffReviewVerdict).toBe('skipped');
  });

  it("kind='approve' → envelope 'approved' (terminal stays false)", async () => {
    const ctx = makeCtx(repoDir, { complex: mockProvider('APPROVE') });
    const state = makeState({ executionContext: ctx, verifyResult: passingVerify });
    await reviewDiffHandler(state);
    expect(state.diffReviewKind).toBe('approve');
    expect(state.diffReviewVerdict).toBe('approved');
    expect(state.terminal).toBe(false);
  });

  it("kind='concerns' → envelope 'approved' (counter-intuitive mapping)", async () => {
    const ctx = makeCtx(repoDir, { complex: mockProvider('CONCERNS: minor formatting issue') });
    const state = makeState({ executionContext: ctx, verifyResult: passingVerify });
    await reviewDiffHandler(state);
    expect(state.diffReviewKind).toBe('concerns');
    expect(state.diffReviewVerdict).toBe('approved');
    expect(state.terminal).toBe(false);
  });

  it("kind='reject' → envelope 'changes_required' (terminal=true)", async () => {
    const ctx = makeCtx(repoDir, { complex: mockProvider('REJECT: serious problem') });
    const state = makeState({ executionContext: ctx, verifyResult: passingVerify });
    await reviewDiffHandler(state);
    expect(state.diffReviewKind).toBe('reject');
    expect(state.diffReviewVerdict).toBe('changes_required');
    expect(state.terminal).toBe(true);
  });

  it('git failure (no HEAD~) → envelope error and terminal', async () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-empty-'));
    try {
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });
      const ctx = makeCtx(emptyRepo, { complex: mockProvider('APPROVE') });
      const state = makeState({ executionContext: ctx, verifyResult: passingVerify });
      await reviewDiffHandler(state);
      expect(state.diffReviewVerdict).toBe('error');
      expect(state.terminal).toBe(true);
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });
});
