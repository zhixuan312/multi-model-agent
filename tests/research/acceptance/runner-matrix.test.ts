import { describe, it, expect } from 'vitest';
import { runOrchestrator } from '../../../packages/core/src/research/orchestrator.js';
import { runTwoTurnDriver } from '../../../packages/core/src/tools/research/two-turn-driver.js';

// Helpers create a fake session with controllable turn responses.
// IMPORTANT: TurnResult.output (NOT .text); terminationReason: 'ok' (NOT 'normal').
const makeSession = (responses: string[]) => {
  let i = 0;
  return { send: async () => ({
    output: responses[i++] ?? '',
    durationMs: 1, costUSD: 0, turns: 1,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    terminationReason: 'ok' as const,
    filesWritten: [], usedShell: false,
  })};
};

const validPlan = JSON.stringify({
  braveQueries: ['q'], arxivQueries: ['a'], semanticScholarQueries: [],
  githubQueries: [], rssFeeds: [], directFetches: [],
});

describe('Acceptance — runner matrix + closed pipeline (A1, A2, A3, A4)', () => {
  it('A1+A2: driver is runner-agnostic — runs to plan+pack under any Session.send shape', async () => {
    // The driver only consumes session.send() returning TurnResult.output —
    // identical for ClaudeSession and CodexCliSession.
    const out = await runTwoTurnDriver({
      session: makeSession([validPlan]) as any,
      runOrchestrator: async () => ({
        sources: [{ source: 'arxiv', query: 'a', title: 'A1', url: 'https://arxiv/1', snippet: 's', rank: 0 }],
        failedAttempts: [], generatedAt: 'x', totalQueries: 1, budgetExceeded: false,
      }),
      researchQuestion: 'How do stablecoins work?', background: undefined, contextBlocks: [],
    });
    expect(out.plan.braveQueries).toEqual(['q']);
    expect(out.plan.arxivQueries).toEqual(['a']);
    expect(out.pack.sources.length).toBe(1);
  });

  it('A3 negative: turn-1 and implementer-prefix prompts never name native model tools', async () => {
    const { compileTurn1PlanPrompt, compileResearchImplementerPrefix } =
      await import('../../../packages/core/src/tools/research/brief-slot.js');
    const turn1 = compileTurn1PlanPrompt({ researchQuestion: 'Q?' });
    const prefix = compileResearchImplementerPrefix({
      researchQuestion: 'Q?',
      pack: { sources: [], failedAttempts: [], generatedAt: 'x', totalQueries: 0, budgetExceeded: false },
      contextBlocks: [],
    });
    for (const p of [turn1, prefix]) {
      expect(p).not.toMatch(/\bWebSearch\b/);
      expect(p).not.toMatch(/\bWebFetch\b/);
      expect(p).not.toMatch(/\bBash\b/);
      expect(p).not.toMatch(/`Read`|`Grep`|`Glob`/);
    }
  });

  it('A3 positive: driver invokes runOrchestrator exactly once', async () => {
    let calls = 0;
    await runTwoTurnDriver({
      session: makeSession([validPlan]) as any,
      runOrchestrator: async () => { calls++; return { sources: [], failedAttempts: [], generatedAt: 'x', totalQueries: 0, budgetExceeded: false }; },
      researchQuestion: 'Q?', background: undefined, contextBlocks: [],
    });
    expect(calls).toBe(1);
  });

  it('A4: tools/research/tool-config sets tools=none (no native tool surface)', async () => {
    const mod = await import('../../../packages/core/src/tools/research/tool-config.js');
    const fakeCtx: any = { config: { defaults: { timeoutMs: 1000, sandboxPolicy: 'cwd-only' } }, cwd: '/tmp', projectContext: undefined, mainModel: 'claude-opus-4-7' };
    const spec = mod.toolConfig.buildTaskSpec({ compiledPrompt: 'p', contextBlockIds: [] } as any, fakeCtx);
    expect(spec.tools).toBe('none');
  });
});
