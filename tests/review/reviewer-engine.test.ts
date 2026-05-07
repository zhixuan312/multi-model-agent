import { describe, it, expect, vi } from 'vitest';
import {
  ReviewerEngine,
  ReviewerParseError,
} from '../../packages/core/src/review/reviewer-engine.js';
import { ReviewerPromptBuilder } from '../../packages/core/src/review/reviewer-prompt-builder.js';
import { specTemplate } from '../../packages/core/src/review/templates/spec-review.js';
import { qualityAPTemplate } from '../../packages/core/src/review/templates/quality-review-artifact.js';
import { diffTemplate } from '../../packages/core/src/review/templates/diff-review.js';
import type { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import type { RunResult } from '../../packages/core/src/providers/runner-shell-types.js';

function makeEngine() {
  const builder = new ReviewerPromptBuilder(
    { spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate },
    {},
  );
  return new ReviewerEngine(builder);
}

function shellResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    workerStatus: 'done',
    finalAssistantText: '',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    ...overrides,
  };
}

function mockShell(result: RunResult): RunnerShell {
  return { run: vi.fn().mockResolvedValue(result) } as unknown as RunnerShell;
}

const baseInput = {
  workerOutput: 'some worker output',
  brief: 'do the thing',
  cwd: '/tmp/test',
};

// ---------------------------------------------------------------------------
// Positive cases — spec branch
// ---------------------------------------------------------------------------
describe('ReviewerEngine.runSpec', () => {
  it('parses an approved verdict from a valid summary', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
      usage: { inputTokens: 42, outputTokens: 7, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      toolCalls: [],
    }));

    const result = await engine.runSpec(shell, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([]);
  });

  it('parses a changes_required verdict', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '## Summary\nchanges_required — the worker missed edge cases',
    }));

    const result = await engine.runSpec(shell, baseInput);

    expect(result.verdict).toBe('changes_required');
  });

  it('extracts concerns from Deviations and Unresolved sections', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: [
        '## Summary',
        'approved',
        '',
        '## Deviations from brief',
        '- Missing error handling in parse()',
        '- Did not add the /status endpoint',
        '',
        '## Unresolved',
        '- Thread-safety of the cache is unclear',
      ].join('\n'),
    }));

    const result = await engine.runSpec(shell, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([
      'Missing error handling in parse()',
      'Did not add the /status endpoint',
      'Thread-safety of the cache is unclear',
    ]);
  });

  it('extracts concerns from a JSON block', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: [
        '## Summary',
        'changes_required',
        '',
        '```json',
        '{"verdict":"changes_required","concerns":["Missing null check","No tests"]}',
        '```',
      ].join('\n'),
    }));

    const result = await engine.runSpec(shell, baseInput);

    expect(result.verdict).toBe('changes_required');
    expect(result.concerns).toEqual(['Missing null check', 'No tests']);
  });

  it('returns a well-shaped cost object', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '## Summary\napproved',
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 5 },
      toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }, { name: 'grep', input: { pattern: 'x' } }],
    }));

    const result = await engine.runSpec(shell, baseInput);

    expect(result.cost).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 0,
      toolCallCount: 2,
      costUSD: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Positive cases — qualityAP branch
// ---------------------------------------------------------------------------
describe('ReviewerEngine.runQualityAP', () => {
  it('parses an approved verdict', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '## Summary\napproved',
    }));

    const result = await engine.runQualityAP(shell, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([]);
  });

  it('parses a changes_required verdict with concerns', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: [
        '## Summary',
        'changes_required',
        '',
        '## Deviations from brief',
        '- SQL query is vulnerable to injection',
      ].join('\n'),
    }));

    const result = await engine.runQualityAP(shell, baseInput);

    expect(result.verdict).toBe('changes_required');
    expect(result.concerns).toEqual(['SQL query is vulnerable to injection']);
  });
});

// ---------------------------------------------------------------------------
// Positive cases — diff branch
// ---------------------------------------------------------------------------
describe('ReviewerEngine.runDiff', () => {
  it('parses APPROVE verdict', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: 'APPROVE',
    }));

    const result = await engine.runDiff(shell, baseInput);

    expect(result.verdict).toBe('approve');
    expect(result.concerns).toEqual([]);
  });

  it('parses CONCERNS verdict', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: 'CONCERNS: the diff touches a hot path without adding coverage',
    }));

    const result = await engine.runDiff(shell, baseInput);

    expect(result.verdict).toBe('concerns');
  });

  it('parses REJECT verdict', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: 'REJECT: the diff introduces a security vulnerability',
    }));

    const result = await engine.runDiff(shell, baseInput);

    expect(result.verdict).toBe('reject');
  });

  it('returns cost shape on diff result', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: 'APPROVE',
      usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      toolCalls: [],
    }));

    const result = await engine.runDiff(shell, baseInput);

    expect(result.cost).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      turnCount: 0,
      toolCallCount: 0,
      costUSD: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------
describe('ReviewerEngine negative cases', () => {
  it('throws ReviewerParseError when ## Summary section is missing', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: 'no summary here, just rambling',
    }));

    await expect(engine.runSpec(shell, baseInput)).rejects.toThrow(ReviewerParseError);
    await expect(engine.runSpec(shell, baseInput)).rejects.toThrow('reviewer output missing ## Summary section');
  });

  it('throws ReviewerParseError when finalAssistantText is empty', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '',
    }));

    await expect(engine.runSpec(shell, baseInput)).rejects.toThrow(ReviewerParseError);
  });

  it('throws ReviewerParseError for diff when verdict is missing', async () => {
    const engine = makeEngine();
    const shell = mockShell(shellResult({
      finalAssistantText: '## Summary\nlooks good to me',
    }));

    await expect(engine.runDiff(shell, baseInput)).rejects.toThrow(ReviewerParseError);
    await expect(engine.runDiff(shell, baseInput)).rejects.toThrow('diff reviewer output missing verdict');
  });

  it('propagates transport error from shell', async () => {
    const engine = makeEngine();
    const transportError = new Error('ECONNREFUSED');
    const shell = {
      run: vi.fn().mockRejectedValue(transportError),
    } as unknown as RunnerShell;

    await expect(engine.runSpec(shell, baseInput)).rejects.toThrow('ECONNREFUSED');
  });

  it('passes abortSignal through to shell.run', async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    const shell = {
      run: vi.fn().mockResolvedValue(shellResult({ finalAssistantText: '## Summary\napproved' })),
    } as unknown as RunnerShell;

    await engine.runSpec(shell, { ...baseInput, abortSignal: controller.signal });

    expect(shell.run).toHaveBeenCalledTimes(1);
    const callInput = (shell.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callInput.abortSignal).toBe(controller.signal);
  });

  it('passes deadlineMs through to shell.run', async () => {
    const engine = makeEngine();
    const shell = {
      run: vi.fn().mockResolvedValue(shellResult({ finalAssistantText: '## Summary\napproved' })),
    } as unknown as RunnerShell;

    await engine.runSpec(shell, { ...baseInput, deadlineMs: 30_000 });

    const callInput = (shell.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callInput.deadlineMs).toBe(30_000);
  });

  it('handles null/undefined finalAssistantText gracefully (parse error, not crash)', async () => {
    const engine = makeEngine();
    // shellResult defaults finalAssistantText to '', but we explicitly pass null-ish
    const shell = mockShell(shellResult({ finalAssistantText: undefined as unknown as string }));

    // finalAssistantText ?? '' → '' → missing Summary → parse error
    await expect(engine.runSpec(shell, baseInput)).rejects.toThrow(ReviewerParseError);
  });
});
