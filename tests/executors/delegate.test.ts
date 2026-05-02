import { describe, it, expect } from 'vitest';
import {
  executeDelegate,
  synthesizeProposedInterpretation,
  assertInterpretationAvailable,
} from '../../packages/core/src/executors/delegate.js';
import { buildExecutionContext } from '../../packages/core/src/executors/execution-context.js';
import type { ExecutionContext } from '../../packages/core/src/executors/types.js';
import type { ProjectContext } from '../../packages/core/src/project-context.js';
import type { ClarificationEntry } from '../../packages/core/src/intake/types.js';
import { notApplicable, isNotApplicable } from '../../packages/core/src/reporting/not-applicable.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClarificationEntry(overrides?: Partial<ClarificationEntry>): ClarificationEntry {
  return {
    draftId: 'draft-1',
    taskIndex: 0,
    proposedDraft: { prompt: 'test prompt' },
    assumptions: [],
    questions: overrides?.questions ?? ['Did you mean refactor X or rewrite X?'],
    reason: overrides?.reason ?? 'prompt is too vague to form one concrete instruction',
  };
}

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  const pc = {
    cwd: '/tmp/test',
    batchCache: {
      remember: () => 'test-batch-id',
      abort: () => {},
      complete: () => {},
    },
    clarifications: { create: () => 'test-clarification-id' },
  } as unknown as ProjectContext;

  return buildExecutionContext({
    projectContext: pc,
    config: {
      agents: {
        standard: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
        complex: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: { timeoutMs: 600_000, tools: 'full', sandboxPolicy: 'cwd-only', maxCostUSD: 10 },
      server: {
        bind: '127.0.0.1', port: 7337,
        auth: { tokenFile: '/tmp/token' },
        limits: { maxBodyBytes: 10_000_000, batchTtlMs: 600_000, idleProjectTimeoutMs: 600_000, clarificationTimeoutMs: 600_000, projectCap: 100, maxBatchCacheSize: 1000, maxContextBlockBytes: 10_000_000, maxContextBlocksPerProject: 100, shutdownDrainMs: 5_000 },
        autoUpdateSkills: false,
      },
    },
    logger: { emit: () => {} } as any,
    contextBlockStore: { register: () => ({ id: 'test-ctx' }), get: () => ({ content: '' }) } as any,
    batchId: 'test-batch',
    ...overrides,
  });
}

const injectDefaults = (ts: any[]) => ts.map((t) => ({ ...t, tools: 'full' as const, timeoutMs: 600_000, cwd: '/tmp/test' }));

// ---------------------------------------------------------------------------
// synthesizeProposedInterpretation helper — edge cases
// ---------------------------------------------------------------------------

describe('synthesizeProposedInterpretation', () => {
  it('uses first clarification question when available', () => {
    const clarifications = [
      makeClarificationEntry({ questions: ['Did you mean refactor X or rewrite X?'] }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request as the answer to: Did you mean refactor X or rewrite X?');
  });

  it('falls back to reason when questions array is empty', () => {
    const clarifications = [
      makeClarificationEntry({ questions: [], reason: 'ambiguous task scope' }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request based on: ambiguous task scope');
  });

  it('falls back to generic phrase when first question is empty string', () => {
    const clarifications = [
      makeClarificationEntry({ questions: [''], reason: '' }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request based on the proposed draft');
  });

  it('falls back to reason when first question is whitespace only', () => {
    const clarifications = [
      makeClarificationEntry({ questions: ['   '], reason: 'ambiguous task scope' }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    // trim() yields '' → falsy → falls through to reason
    expect(result).toBe('Interpreting your request based on: ambiguous task scope');
  });

  it('falls back to generic phrase when questions and reason are both empty', () => {
    const clarifications = [
      makeClarificationEntry({ questions: [], reason: '' }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request based on the proposed draft');
  });

  it('uses first clarification among multiple entries', () => {
    const clarifications = [
      makeClarificationEntry({ questions: ['First question?'], taskIndex: 0 }),
      makeClarificationEntry({ questions: ['Second question?'], taskIndex: 1 }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request as the answer to: First question?');
  });

  it('handles single clarification with multiple questions', () => {
    const clarifications = [
      makeClarificationEntry({
        questions: ['Is the target file src/app.ts?', 'Should tests be included?'],
      }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    // Uses first question only
    expect(result).toBe('Interpreting your request as the answer to: Is the target file src/app.ts?');
  });

  it('handles clarification with undefined questions (defensive)', () => {
    // Bypass makeClarificationEntry's defaults by spreading and overriding
    const base = makeClarificationEntry();
    const clarifications: ClarificationEntry[] = [
      { ...base, questions: undefined as unknown as string[], reason: '' },
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    // questions is undefined → falls through to reason → reason is empty → falls through to generic
    expect(result).toBe('Interpreting your request based on the proposed draft');
  });

  it('uses reason when questions array has only empty strings', () => {
    const clarifications = [
      makeClarificationEntry({ questions: [''], reason: 'MCP cannot form one unambiguous execution plan' }),
    ];
    const result = synthesizeProposedInterpretation(clarifications);
    expect(result).toBe('Interpreting your request based on: MCP cannot form one unambiguous execution plan');
  });

  it('produces a non-empty string for any well-formed clarification', () => {
    // Fuzz: all combinations of undefined/missing fields should still produce a non-empty string
    const cases: ClarificationEntry[] = [
      makeClarificationEntry({ questions: ['q'], reason: 'r' }),
      makeClarificationEntry({ questions: [], reason: 'r' }),
      makeClarificationEntry({ questions: [''], reason: '' }),
      makeClarificationEntry({ questions: undefined as any, reason: undefined as any }),
    ];
    for (const c of cases) {
      const result = synthesizeProposedInterpretation([c]);
      expect(typeof result).toBe('string');
      expect(result.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// assertInterpretationAvailable invariant — bug-path tests
// ---------------------------------------------------------------------------

describe('assertInterpretationAvailable', () => {
  it('throws when clarification is pending but interpretation is notApplicable', () => {
    expect(() =>
      assertInterpretationAvailable(true, notApplicable('should not happen')),
    ).toThrow('proposedInterpretation invariant violation: clarifications present but interpretation is not_applicable');
  });

  it('does not throw when clarification is pending and interpretation is a string', () => {
    expect(() =>
      assertInterpretationAvailable(true, 'Some interpretation string'),
    ).not.toThrow();
  });

  it('does not throw when clarification is not pending (even with notApplicable)', () => {
    expect(() =>
      assertInterpretationAvailable(false, notApplicable('batch not awaiting clarification')),
    ).not.toThrow();
  });

  it('does not throw when no clarification and string interpretation', () => {
    expect(() =>
      assertInterpretationAvailable(false, 'some string'),
    ).not.toThrow();
  });

  it('protects against the exact bug path: clarifications present + notApplicable interpretation', () => {
    // Simulate what would happen if envelope construction regresses:
    // clarifications exist but proposedInterpretation is accidentally notApplicable
    const hasClarifications = true;
    const buggyInterpretation = notApplicable('oops, forgot to synthesize');

    expect(() =>
      assertInterpretationAvailable(hasClarifications, buggyInterpretation),
    ).toThrow(/proposedInterpretation invariant violation/);
  });
});

// ---------------------------------------------------------------------------
// executeDelegate clarification path — integration tests
// ---------------------------------------------------------------------------

describe('executeDelegate clarification path', () => {
  it('populates proposedInterpretation as a non-empty string when clarifications exist', async () => {
    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Can you help' }] },
      { injectDefaults },
    );

    expect(result.clarifications).toBeDefined();
    expect(result.clarifications!.length).toBeGreaterThan(0);
    expect(typeof result.proposedInterpretation).toBe('string');
    expect(result.proposedInterpretation).not.toBe('');
    expect(isNotApplicable(result.proposedInterpretation)).toBe(false);
    // The interpretation is distinct from the literal question (synthesis prefix)
    const firstQuestion = result.clarifications![0].questions[0];
    expect(result.proposedInterpretation).not.toBe(firstQuestion);
    expect(result.proposedInterpretation).toContain(firstQuestion);
  });

  it('returns notApplicable proposedInterpretation when no clarifications exist', async () => {
    // A concrete prompt that passes intake classification as 'ready'.
    // Use runTasksOverride so we don't try to call a real provider.
    const runTasksOverride = async () => [{
      output: 'hello world',
      status: 'ok' as const,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001, costDeltaVsParentUSD: null, cachedTokens: null, reasoningTokens: null },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      durationMs: 0,
    }];

    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Write a hello world function in TypeScript' }] },
      { injectDefaults, runTasksOverride },
    );

    expect(isNotApplicable(result.proposedInterpretation)).toBe(true);
    if (isNotApplicable(result.proposedInterpretation)) {
      expect(result.proposedInterpretation.reason).toBe('batch not awaiting clarification');
    }
  });

  it('includes clarificationId when clarifications exist', async () => {
    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Can you help' }] },
      { injectDefaults },
    );

    expect(result.clarificationId).toBeDefined();
    expect(typeof result.clarificationId).toBe('string');
  });

  it('sets results, batchTimings, costSummary, structuredReport as notApplicable when awaiting clarification', async () => {
    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Can you help' }] },
      { injectDefaults },
    );

    expect(isNotApplicable(result.results)).toBe(true);
    expect(isNotApplicable(result.batchTimings)).toBe(true);
    expect(isNotApplicable(result.costSummary)).toBe(true);
    expect(isNotApplicable(result.structuredReport)).toBe(true);
  });
});
