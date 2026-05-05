import { describe, it, expect, vi } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';
import { emptyStats, executeReviewedLifecycle } from '../../packages/core/src/lifecycle/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider, RunResult } from '../../packages/core/src/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'deepseek-v4-pro',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
      complex: {
        type: 'openai-compatible',
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: 'full',
      sandboxPolicy: 'cwd-only',
    },
    server: {
      bind: '127.0.0.1',
      port: 7337,
      auth: { tokenFile: '/tmp/mock-token' },
      limits: {
        maxBodyBytes: 1_000_000,
        batchTtlMs: 300_000,
        idleProjectTimeoutMs: 3_600_000,
        clarificationTimeoutMs: 300_000,
        projectCap: 10,
        maxBatchCacheSize: 10,
        maxContextBlockBytes: 100_000,
        maxContextBlocksPerProject: 10,
        shutdownDrainMs: 5_000,
      },
      autoUpdateSkills: false,
    },
  };
}

describe('Item 9: silent incomplete is now self-explanatory', () => {
  it('runner returns incomplete with no summary → errorCode incomplete_no_summary', async () => {
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: 'Task was interrupted mid-execution. No summary available.',
        status: 'incomplete' as const,
        usage: { inputTokens: 5000, outputTokens: 500, totalTokens: 5500, costUSD: 0.01 },
        turns: 5,
        filesRead: ['src/a.ts'],
        filesWritten: [],
        toolCalls: ['readFile(src/a.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 30000,
      }),
    };

    const task: TaskSpec = {
      prompt: 'implement feature X',
      agentType: 'standard' as const,
      reviewPolicy: 'none' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: primaryProvider,
  
    };

    const config = makeConfig();
    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('incomplete_no_summary');

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.terminalStatus).toBe('incomplete');
    expect(event.errorCode).toBe('incomplete_no_summary');

    const validation = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(validation.success).toBe(true);
  });

  it('output with empty placeholder summary → errorCode incomplete_no_summary', async () => {
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: [
          '## Summary', 'N/A', '',
          '## Files changed', '- src/a.ts: partial edits', '',
          '## Validations run', 'none', '',
          '## Deviations from brief', '',
          '## Unresolved', 'interrupted', '',
        ].join('\n'),
        status: 'incomplete' as const,
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01 },
        turns: 2,
        filesRead: ['src/a.ts'],
        filesWritten: ['src/a.ts'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 8000,
      }),
    };

    const result = await executeReviewedLifecycle(
      { prompt: 'implement feature X', agentType: 'standard', reviewPolicy: 'none', timeoutMs: 300_000 },
      { slot: 'standard', provider: primaryProvider },
      makeConfig(),
      0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('incomplete_no_summary');

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });
    expect(event.errorCode).toBe('incomplete_no_summary');
  });

  it('diagnostic-looking incomplete output → errorCode incomplete_no_summary', async () => {
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: 'Sub-agent error: provider stopped before producing a structured summary.',
        status: 'incomplete' as const,
        usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550, costUSD: 0.005 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: true,
        escalationLog: [],
        durationMs: 4000,
      }),
    };

    const result = await executeReviewedLifecycle(
      { prompt: 'implement feature X', agentType: 'standard', reviewPolicy: 'none', timeoutMs: 300_000 },
      { slot: 'standard', provider: primaryProvider },
      makeConfig(),
      0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('incomplete_no_summary');
  });

  it('incomplete output with non-summary sections → errorCode incomplete_no_summary', async () => {
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: [
          '## Files changed', '- src/a.ts: partial edits', '',
          '## Validations run', '- not run: interrupted', '',
          '## Unresolved', '- implementation stopped before completion', '',
        ].join('\n'),
        status: 'incomplete' as const,
        usage: { inputTokens: 800, outputTokens: 80, totalTokens: 880, costUSD: 0.008 },
        turns: 2,
        filesRead: ['src/a.ts'],
        filesWritten: ['src/a.ts'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 7000,
      }),
    };

    const result = await executeReviewedLifecycle(
      { prompt: 'implement feature X', agentType: 'standard', reviewPolicy: 'none', timeoutMs: 300_000 },
      { slot: 'standard', provider: primaryProvider },
      makeConfig(),
      0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('incomplete_no_summary');
  });

  it('round_cap with worker-completed summary preserves workerStatus done', async () => {
    const structuredOutput = [
      '## Summary',
      'implementation complete with all tests passing',
      '',
      '## Files changed',
      '- src/a.ts: updated function signature',
      '- tests/a.test.ts: added new test cases',
      '',
      '## Normalization decisions',
      '',
      '## Validations run',
      '- npm test: passed',
      '',
      '## Deviations from brief',
      '',
      '## Unresolved',
      '',
    ].join('\n');

    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: structuredOutput,
        status: 'incomplete' as const,
        usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.05 },
        turns: 12,
        filesRead: ['src/a.ts', 'tests/a.test.ts'],
        filesWritten: ['src/a.ts', 'tests/a.test.ts'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)', 'readFile(tests/a.test.ts)', 'writeFile(tests/a.test.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 60000,
      }),
    };

    const task: TaskSpec = {
      prompt: 'implement feature X',
      agentType: 'standard' as const,
      reviewPolicy: 'none' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: primaryProvider,
  
    };

    const config = makeConfig();
    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('incomplete');
    expect(result.workerStatus).toBe('done');
    // When the structured report has a summary, errorCode should not be
    // 'incomplete_no_summary' (it wasn't silent).
    if (result.errorCode) {
      expect(result.errorCode).not.toBe('incomplete_no_summary');
    }

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.terminalStatus).toBe('incomplete');
    expect(event.workerStatus).toBe('done');

    const validation = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(validation.success).toBe(true);
  });

  it('deriveErrorCode reads rr.errorCode (not just structuredError.code)', () => {
    const runResult: RunResult = {
      output: 'interrupted — no summary',
      status: 'incomplete',
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUSD: 0.01 },
      turns: 3,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      durationMs: 5000,
      workerStatus: 'done',
      errorCode: 'incomplete_no_summary',
      stageStats: {
        ...emptyStats(),
        implementing: {
          stage: 'implementing',
          entered: true,
          durationMs: 5000,
          costUSD: 0.01,
          agentTier: 'standard',
          modelFamily: null,
          model: 'gpt-5.2',
          maxIdleMs: 0,
          totalIdleMs: 0,
          activityEvents: 0,
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: null,
          reasoningTokens: null,
          turnCount: 3,
          toolCallCount: 0,
          filesReadCount: 0,
          filesWrittenCount: 0,
        },
      },
      models: { implementer: 'gpt-5.2', specReviewer: null, qualityReviewer: null },
      agents: { implementer: 'standard', implementerToolMode: 'full', specReviewer: 'not_applicable', qualityReviewer: 'not_applicable' },
      concerns: [],
    };

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.errorCode).toBe('incomplete_no_summary');

    const validation = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(validation.success).toBe(true);
  });

  it('errorCode is null when run finishes ok', async () => {
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: makeConfig().agents.standard,
      run: async () => ({
        output: [
          '## Summary', 'task completed successfully', '',
          '## Files changed', '- src/a.ts: updated', '',
          '## Normalization decisions', '',
          '## Validations run', '- npm test: passed', '',
          '## Deviations from brief', '',
          '## Unresolved', '',
        ].join('\n'),
        status: 'ok' as const,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUSD: 0.01 },
        turns: 2,
        filesRead: ['src/a.ts'],
        filesWritten: ['src/a.ts'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 10000,
      }),
    };

    const task: TaskSpec = {
      prompt: 'edit src/a.ts',
      agentType: 'standard' as const,
      reviewPolicy: 'none' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: primaryProvider,
  
    };

    const config = makeConfig();
    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('ok');
    expect(result.errorCode).toBeFalsy();

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.errorCode).toBeNull();
  });
});

describe('deriveErrorCode allowlist', () => {
  const baseResult: RunResult = {
    output: '',
    status: 'incomplete',
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUSD: 0.01 },
    turns: 2,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 5000,
    stageStats: {
      ...emptyStats(),
      implementing: {
        stage: 'implementing',
        entered: true,
        durationMs: 5000,
        costUSD: 0.01,
        agentTier: 'standard',
        modelFamily: null,
        model: 'gpt-5.2',
        maxIdleMs: 0,
        totalIdleMs: 0,
        activityEvents: 0,
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: null,
        reasoningTokens: null,
        turnCount: 2,
        toolCallCount: 0,
        filesReadCount: 0,
        filesWrittenCount: 0,
      },
    },
    models: { implementer: 'gpt-5.2', specReviewer: null, qualityReviewer: null },
    agents: { implementer: 'standard', implementerToolMode: 'full', specReviewer: 'not_applicable', qualityReviewer: 'not_applicable' },
    concerns: [],
  };

  function eventFor(rr: RunResult) {
    return buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test-client',
      mainModel: null,
    });
  }

  it('structuredError.code=api_aborted maps to api_error', () => {
    const rr: RunResult = {
      ...baseResult,
      structuredError: { code: 'api_aborted', message: 'aborted' },
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBe('api_error');
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('structuredError.code=timeout drops to null', () => {
    const rr: RunResult = {
      ...baseResult,
      structuredError: { code: 'timeout', message: 'timed out' },
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('errorCode=incomplete (status-level fallback) drops to null', () => {
    const rr: RunResult = {
      ...baseResult,
      status: 'incomplete',
      errorCode: 'incomplete',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('errorCode=error (status-level fallback) drops to null', () => {
    const rr: RunResult = {
      ...baseResult,
      status: 'error',
      errorCode: 'error',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('errorCode=timeout drops to null (not in telemetry enum)', () => {
    const rr: RunResult = {
      ...baseResult,
      errorCode: 'timeout',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('structuredError.code takes precedence over errorCode', () => {
    const rr: RunResult = {
      ...baseResult,
      errorCode: 'incomplete_no_summary',
      structuredError: { code: 'runner_crash', message: 'crash' },
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBe('runner_crash');
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('errorCode retains incomplete_no_summary (valid enum value)', () => {
    const rr: RunResult = {
      ...baseResult,
      errorCode: 'incomplete_no_summary',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBe('incomplete_no_summary');
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('unrecognized errorCode string drops to null', () => {
    const rr: RunResult = {
      ...baseResult,
      errorCode: 'provider_specific_error',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });

  it('errorCode=api_aborted drops to null (not in telemetry enum)', () => {
    const rr: RunResult = {
      ...baseResult,
      errorCode: 'api_aborted',
    };
    const ev = eventFor(rr);
    expect(ev.errorCode).toBeNull();
    expect(ValidatedTaskCompletedEventSchema.safeParse(ev).success).toBe(true);
  });
});
