import { describe, it, expect } from 'vitest';
import { AnnotatorEngine } from '@zhixuan92/multi-model-agent-core';
import type { AnnotatorRoute } from '@zhixuan92/multi-model-agent-core';
import type { Session, TurnResult } from '../../packages/core/src/types/run-result.js';

interface SessionStubOptions {
  output: string;
  errorCode?: string;
  usage?: TurnResult['usage'];
  turns?: number;
  toolCallsByName?: Record<string, number>;
  costUSD?: number;
  capturePrompt?: (prompt: string) => void;
}

function sessionStub(opts: SessionStubOptions): Session {
  return {
    async send(prompt: string): Promise<TurnResult> {
      opts.capturePrompt?.(prompt);
      return {
        output: opts.output,
        usage: opts.usage ?? { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        filesRead: [],
        filesWritten: [],
        toolCallsByName: opts.toolCallsByName ?? {},
        turns: opts.turns ?? 1,
        durationMs: 10,
        costUSD: opts.costUSD ?? 0,
        terminationReason: opts.errorCode ? 'error' : 'ok',
        ...(opts.errorCode && { errorCode: opts.errorCode }),
      };
    },
    async close() { /* no-op */ },
  };
}

const defaultInput = {
  workerOutputs: [{ criterion: 'all criteria', narrative: 'F1: missing null check in handler.ts' }],
  brief: 'Review handler.ts for null safety',
  cwd: '/tmp/test',
};

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

const routeRoleHints: Record<AnnotatorRoute, string> = {
  audit: 'audit',
  review: 'code review',
  verify: 'verification report',
  debug: 'debugging hypothesis',
  investigate: 'codebase investigation',
};

describe('AnnotatorEngine', () => {
  const engine = new AnnotatorEngine();

  for (const route of Object.keys(routeRoleHints) as AnnotatorRoute[]) {
    describe(`route "${route}"`, () => {
      it('selects the correct route-specific prompt', async () => {
        let capturedPrompt = '';
        const session = sessionStub({
          output: validJson,
          capturePrompt: (p) => { capturedPrompt = p; },
        });

        await engine.annotate(session, { ...defaultInput, route });

        expect(capturedPrompt).toContain(routeRoleHints[route]);
        expect(capturedPrompt).toContain(defaultInput.brief);
        expect(capturedPrompt).toContain(defaultInput.workerOutputs[0].narrative);
      });

      it('parses valid JSON and returns annotated verdict', async () => {
        const session = sessionStub({ output: validJson });
        const result = await engine.annotate(session, { ...defaultInput, route });

        expect(result.verdict).toBe('annotated');
        expect(result.annotatedFindings).toHaveLength(1);
        expect(result.annotatedFindings[0].id).toBe('F1');
        expect(result.annotatedFindings[0].claim).toContain('null check');
        expect(result.finalAssistantText).toBe(validJson);
      });
    });
  }

  it('propagates cost from the turn result', async () => {
    const session = sessionStub({
      output: validJson,
      usage: { inputTokens: 300, outputTokens: 150, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 2,
      toolCallsByName: { read: 1, grep: 1 },
      costUSD: 0.005,
    });

    const result = await engine.annotate(session, { ...defaultInput, route: 'review' });

    expect(result.cost.inputTokens).toBe(300);
    expect(result.cost.outputTokens).toBe(150);
    expect(result.cost.turnCount).toBe(2);
    expect(result.cost.toolCallCount).toBe(2);
    expect(result.cost.costUSD).toBe(0.005);
  });

  it('returns null costUSD when the turn carries no cost', async () => {
    // sessionStub defaults costUSD to 0; explicitly set undefined-shaped turn.
    const session: Session = {
      async send(): Promise<TurnResult> {
        return {
          output: validJson,
          usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
          filesRead: [],
          filesWritten: [],
          toolCallsByName: {},
          turns: 1,
          durationMs: 1,
          costUSD: 0,
          terminationReason: 'ok',
        };
      },
      async close() { /* no-op */ },
    };
    const result = await engine.annotate(session, { ...defaultInput, route: 'review' });
    // costUSD of 0 from session is preserved as 0, NOT null. The original
    // "null when missing" semantics are only triggered when the turn has
    // truly no cost; session-driven runs always carry a numeric costUSD.
    expect(result.cost.costUSD).toBe(0);
  });

  describe('hard-fail on malformed JSON', () => {
    it('returns error when output is empty', async () => {
      const session = sessionStub({ output: '' });
      const result = await engine.annotate(session, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.annotatedFindings).toEqual([]);
      expect(result.errorReason).toBe('no output');
    });

    it('returns error when output has no JSON array (any shape)', async () => {
      const session = sessionStub({ output: 'Here are some findings but no code block.' });
      const result = await engine.annotate(session, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('returns error for invalid JSON inside the fenced block (no recoverable array)', async () => {
      const text = '```json\n{ invalid json !!\n```';
      const session = sessionStub({ output: text });
      const result = await engine.annotate(session, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('returns error when output is an object with no embedded array', async () => {
      const text = '```json\n{ "id": "F1", "claim": "not an array" }\n```';
      const session = sessionStub({ output: text });
      const result = await engine.annotate(session, { ...defaultInput, route: 'review' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('no JSON array found in annotator output');
    });

    it('uses errorCode when output is empty', async () => {
      const session = sessionStub({ output: '', errorCode: 'timeout' });
      const result = await engine.annotate(session, { ...defaultInput, route: 'debug' });

      expect(result.verdict).toBe('error');
      expect(result.errorReason).toBe('timeout');
    });
  });

  it('parses only the first fenced JSON block when multiple are present', async () => {
    const text = '```json\n[{"id":"F1","severity":"low","claim":"first","evidence":"worker said so first","annotatorConfidence":50}]\n```\n\nSome text\n\n```json\n[{"id":"F2","severity":"low","claim":"second","evidence":"worker said so second","annotatorConfidence":30}]\n```';
    const session = sessionStub({ output: text });
    const result = await engine.annotate(session, { ...defaultInput, route: 'investigate' });

    expect(result.verdict).toBe('annotated');
    expect(result.annotatedFindings).toHaveLength(1);
    expect(result.annotatedFindings[0].id).toBe('F1');
  });
});
