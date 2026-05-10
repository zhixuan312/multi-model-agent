import { describe, it, expect } from 'vitest';
import { AnnotatorEngine, RunnerShell } from '@zhixuan92/multi-model-agent-core';
import type { AnnotatorRoute } from '@zhixuan92/multi-model-agent-core';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

interface ShellStubOptions {
  finalAssistantText: string;
  errorCode?: string;
  usage?: RunResult['usage'];
  turns?: number;
  toolCalls?: RunResult['toolCalls'];
  cost?: { costUSD?: number | null };
}

function shellStub(opts: ShellStubOptions): RunnerShell {
  return {
    run: async () => ({
      workerStatus: opts.errorCode ? 'blocked' : 'done' as const,
      finalAssistantText: opts.finalAssistantText,
      toolCalls: opts.toolCalls ?? [],
      usage: opts.usage ?? { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      errorCode: opts.errorCode,
      turns: opts.turns,
      cost: opts.cost,
    }),
  } as unknown as RunnerShell;
}

const defaultInput = {
  workerOutputs: [{ criterion: 'all criteria', narrative: 'F1: missing null check in handler.ts' }],
  brief: 'Review handler.ts for null safety',
  cwd: '/tmp/test',
};

// ---------------------------------------------------------------------------
// Valid JSON used across all 5 route tests
// ---------------------------------------------------------------------------
const validJson = String.raw`Here are my annotations.

` + '```json\n' + `[
  {
    "id": "F1",
    "severity": "high",
    "claim": "Missing null check in handler.ts:42",
    "evidence": "F1: missing null check in handler.ts",
    "suggestion": "Add a guard clause before dereferencing",
    "annotatorConfidence": 85,
    "category": "security"
  }
]
` + '```';

// ---------------------------------------------------------------------------
// Route-specific prompt checks
// ---------------------------------------------------------------------------
const routeRoleHints: Record<AnnotatorRoute, string> = {
  audit: 'audit',
  review: 'code review',
  verify: 'verification report',
  debug: 'debugging hypothesis',
  investigate: 'codebase investigation',
};

describe('AnnotatorEngine', () => {
  const engine = new AnnotatorEngine();

  // -----------------------------------------------------------------------
  // 5 routes: prompt selection + JSON parse
  // -----------------------------------------------------------------------
  for (const route of Object.keys(routeRoleHints) as AnnotatorRoute[]) {
    describe(`route "${route}"`, () => {
      it('selects the correct route-specific prompt', async () => {
        let capturedPrompt = '';
        const shell = {
          run: async (input: { systemPrompt: string }) => {
            capturedPrompt = input.systemPrompt;
            return {
              workerStatus: 'done' as const,
              finalAssistantText: validJson,
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            };
          },
        } as unknown as RunnerShell;

        await engine.annotate(shell, { ...defaultInput, route });

        expect(capturedPrompt).toContain(routeRoleHints[route]);
        expect(capturedPrompt).toContain(defaultInput.brief);
        expect(capturedPrompt).toContain(defaultInput.workerOutputs[0].narrative);
      });

      it('parses valid JSON and returns annotated verdict', async () => {
        const shell = shellStub({ finalAssistantText: validJson });
        const result = await engine.annotate(shell, { ...defaultInput, route });

        expect(result.verdict).toBe('annotated');
        expect(result.annotatedFindings).toHaveLength(1);
        expect(result.annotatedFindings[0].id).toBe('F1');
        expect(result.annotatedFindings[0].claim).toContain('null check');
        expect(result.finalAssistantText).toBe(validJson);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Cost extraction
  // -----------------------------------------------------------------------
  it('propagates cost from the shell run result', async () => {
    const shell = shellStub({
      finalAssistantText: validJson,
      usage: { inputTokens: 300, outputTokens: 150, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 2,
      toolCalls: [{ name: 'read', input: {}, result: 'ok' }, { name: 'grep', input: {}, result: 'ok' }],
      cost: { costUSD: 0.005 },
    });

    const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });

    expect(result.cost.inputTokens).toBe(300);
    expect(result.cost.outputTokens).toBe(150);
    expect(result.cost.turnCount).toBe(2);
    expect(result.cost.toolCallCount).toBe(2);
    expect(result.cost.costUSD).toBe(0.005);
  });

  it('falls back to usage.costUSD when top-level cost is absent', async () => {
    const shell = shellStub({
      finalAssistantText: validJson,
      usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    });
    // Patch usage.costUSD — shellStub doesn't set it on usage, so we hand-roll
    const shell2 = {
      run: async () => ({
        workerStatus: 'done' as const,
        finalAssistantText: validJson,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0, costUSD: 0.003 },
      }),
    } as unknown as RunnerShell;

    const result = await engine.annotate(shell2, { ...defaultInput, route: 'review' });
    expect(result.cost.costUSD).toBe(0.003);
  });

  it('returns null costUSD when neither cost nor usage has it', async () => {
    const shell = shellStub({ finalAssistantText: validJson });
    const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });
    expect(result.cost.costUSD).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Hard-fail on malformed JSON
  // -----------------------------------------------------------------------
  describe('hard-fail on malformed JSON', () => {
    it('returns error when finalAssistantText is empty', async () => {
      const shell = shellStub({ finalAssistantText: '' });
      const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.annotatedFindings).toEqual([]);
      expect(result.errorReason).toBe('no output');
    });

    it('returns error when finalAssistantText has no JSON array (any shape)', async () => {
      // Tool sweep #12: parser is now lenient — fenced ```json``` /
      // fenced ``` (no lang tag) / bare `[...]` are all accepted.
      // Error fires only when none of those produce a parseable array.
      const shell = shellStub({ finalAssistantText: 'Here are some findings but no code block.' });
      const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('returns error for invalid JSON inside the fenced block (no recoverable array)', async () => {
      const text = '```json\n{ invalid json !!\n```';
      const shell = shellStub({ finalAssistantText: text });
      const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('returns error when output is an object with no embedded array', async () => {
      const text = '```json\n{ "id": "F1", "claim": "not an array" }\n```';
      const shell = shellStub({ finalAssistantText: text });
      const result = await engine.annotate(shell, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('uses errorCode when finalAssistantText is undefined', async () => {
      const shell = shellStub({ finalAssistantText: '', errorCode: 'timeout' });
      const result = await engine.annotate(shell, { ...defaultInput, route: 'debug' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('timeout');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  it('parses only the first fenced JSON block when multiple are present', async () => {
    const text = '```json\n[{"id":"F1","severity":"low","claim":"first","evidence":"worker said so first","annotatorConfidence":50}]\n```\n\nSome text\n\n```json\n[{"id":"F2","severity":"low","claim":"second","evidence":"worker said so second","annotatorConfidence":30}]\n```';
    const shell = shellStub({ finalAssistantText: text });
    const result = await engine.annotate(shell, { ...defaultInput, route: 'investigate' });

    expect(result.verdict).toBe('annotated');
    expect(result.annotatedFindings).toHaveLength(1);
    expect(result.annotatedFindings[0].id).toBe('F1');
  });
});
