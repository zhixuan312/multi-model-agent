import { describe, it, expect, vi } from 'vitest';
import {
  ReviewerEngine,
} from '../../packages/core/src/review/reviewer-engine.js';
import { ReviewerPromptBuilder } from '../../packages/core/src/review/reviewer-prompt-builder.js';
import { specLintTemplate } from '../../packages/core/src/review/templates/spec-review.js';
import { qualityLintTemplate } from '../../packages/core/src/review/templates/quality-review.js';
import { annotateCompletionTemplate } from '../../packages/core/src/review/templates/annotate-completion.js';
import type { Session, TurnResult } from '../../packages/core/src/types/run-result.js';

function makeEngine() {
  const builder = new ReviewerPromptBuilder(
    { spec: specLintTemplate, qualityForAP: qualityLintTemplate, diff: annotateCompletionTemplate },
    {},
  );
  return new ReviewerEngine(builder);
}

function turnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: '',
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    durationMs: 0,
    filesRead: [],
    filesWritten: [],
    toolCallsByName: {},
    costUSD: null,
    terminationReason: 'ok',
    ...overrides,
  };
}

function mockSession(turn: TurnResult): Session {
  return {
    send: vi.fn().mockResolvedValue(turn),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

const baseInput = {
  workerOutput: 'some worker output',
  brief: 'do the thing',
  cwd: '/tmp/test',
};

describe('ReviewerEngine.runSpec', () => {
  it('parses an approved verdict from a valid summary', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
      usage: { inputTokens: 42, outputTokens: 7, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    }));

    const result = await engine.runSpec(session, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([]);
  });

  it('parses a changes_required verdict', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: '## Summary\nchanges_required — the worker missed edge cases',
    }));

    const result = await engine.runSpec(session, baseInput);

    expect(result.verdict).toBe('changes_required');
  });

  it('extracts concerns from Deviations and Unresolved sections', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: [
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

    const result = await engine.runSpec(session, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([
      'Missing error handling in parse()',
      'Did not add the /status endpoint',
      'Thread-safety of the cache is unclear',
    ]);
  });

  it('extracts concerns from a JSON block', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: [
        '## Summary',
        'changes_required',
        '',
        '```json',
        '{"verdict":"changes_required","concerns":["Missing null check","No tests"]}',
        '```',
      ].join('\n'),
    }));

    const result = await engine.runSpec(session, baseInput);

    expect(result.verdict).toBe('changes_required');
    expect(result.concerns).toEqual(['Missing null check', 'No tests']);
  });

  it('returns a well-shaped cost object', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: '## Summary\napproved',
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 5 },
      toolCallsByName: { readFile: 1, grep: 1 },
    }));

    const result = await engine.runSpec(session, baseInput);

    expect(result.cost).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 0,
      toolCallCount: 2,
      costUSD: null,
      durationMs: 0,
    });
  });
});

describe('ReviewerEngine.runQualityAP', () => {
  it('parses an approved verdict', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: '## Summary\napproved',
    }));

    const result = await engine.runQualityAP(session, baseInput);

    expect(result.verdict).toBe('approved');
    expect(result.concerns).toEqual([]);
  });

  it('parses a changes_required verdict with concerns', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: [
        '## Summary',
        'changes_required',
        '',
        '## Deviations from brief',
        '- SQL query is vulnerable to injection',
      ].join('\n'),
    }));

    const result = await engine.runQualityAP(session, baseInput);

    expect(result.verdict).toBe('changes_required');
    expect(result.concerns).toEqual(['SQL query is vulnerable to injection']);
  });
});

describe('ReviewerEngine negative cases', () => {
  it('returns changes_required + meta-concern when ## Summary section is missing (4.0.3 lenient parse)', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: 'no summary here, just rambling',
    }));

    const result = await engine.runSpec(session, baseInput);
    expect(result.verdict).toBe('changes_required');
    expect(result.concerns[0]).toMatch(/missing.*Summary/);
  });

  it('returns changes_required when output is empty (4.0.3 lenient parse)', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({
      output: '',
    }));

    const result = await engine.runSpec(session, baseInput);
    expect(result.verdict).toBe('changes_required');
    expect(result.concerns[0]).toMatch(/missing.*Summary/);
  });

  it('propagates transport error from session', async () => {
    const engine = makeEngine();
    const transportError = new Error('ECONNREFUSED');
    const session = {
      send: vi.fn().mockRejectedValue(transportError),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(engine.runSpec(session, baseInput)).rejects.toThrow('ECONNREFUSED');
  });

  it('handles undefined output gracefully (lenient parse, not crash)', async () => {
    const engine = makeEngine();
    const session = mockSession(turnResult({ output: undefined as unknown as string }));

    const result = await engine.runSpec(session, baseInput);
    expect(result.verdict).toBe('changes_required');
    expect(result.concerns[0]).toMatch(/missing.*Summary/);
  });
});
