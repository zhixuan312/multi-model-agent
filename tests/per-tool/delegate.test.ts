import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { delegateSlot } from '../../packages/core/src/intake/brief-compiler-slots/delegate.js';
import type { DelegateInput } from '../../packages/core/src/intake/brief-compiler-slots/delegate.js';
import { delegateReportSchema } from '../../packages/core/src/reporting/report-parser-slots/delegate-report.js';
import { ReviewerEngine, ReviewerPromptBuilder, specTemplate, qualityAPTemplate, diffTemplate } from '../../packages/core/src/review/reviewer-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeDelegateParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as DelegateInput | undefined;
    if (!req || !Array.isArray(req.tasks) || req.tasks.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = delegateSlot(req);
    (state as any).delegateBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
  };
}

function makeDelegateComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = delegateReportSchema.parse(workerOutput);
    } catch { /* leave null */ }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

function makeReviewHandlers(engine: ReviewerEngine): Record<string, StageHandler> {
  return {
    spec_review_round_1: async (state: LifecycleState) => {
      const result = await engine.runSpec({
        workerOutput: (state.lastRunResult as any)?.finalAssistantText ?? '',
        brief: state.userMessage,
        cwd: (state as any).cwd ?? process.cwd(),
      });
      state.specReviewRound1Verdict = result.verdict as any;
    },
    spec_review_round_2: async (state: LifecycleState) => {
      const result = await engine.runSpec({
        workerOutput: (state.lastRunResult as any)?.finalAssistantText ?? '',
        brief: state.userMessage,
        cwd: (state as any).cwd ?? process.cwd(),
      });
      state.specReviewRound2Verdict = result.verdict as any;
    },
    quality_review_round_1: async (state: LifecycleState) => {
      const result = await engine.runQualityAP({
        workerOutput: (state.lastRunResult as any)?.finalAssistantText ?? '',
        brief: state.userMessage,
        cwd: (state as any).cwd ?? process.cwd(),
      });
      state.qualityReviewRound1Verdict = result.verdict as any;
    },
    review_diff: async (state: LifecycleState) => {
      const result = await engine.runDiff({
        workerOutput: (state.lastRunResult as any)?.finalAssistantText ?? '',
        brief: state.userMessage,
        cwd: (state as any).cwd ?? process.cwd(),
      });
      state.diffReviewVerdict = result.verdict as any;
    },
  };
}

function makeReworkHandler(shell: import('../../packages/core/src/providers/runner-shell.js').RunnerShell): StageHandler {
  return async (state: LifecycleState) => {
    const result = await shell.run((state as any).runInput);
    state.lastRunResult = result;
    state.workerStatus = result.workerStatus;
  };
}

describe('delegate via v4.0 lifecycle', () => {
  it('one task with reviewPolicy=none reaches complete status', async () => {
    const adapter = mockAdapter({
      turns: [{ assistantText: '```json\n{"summary":"did it","filesChanged":["x.ts"]}\n```', toolCalls: [] }],
    });

    const result = await bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDelegateParseBrief(),
      compose_response: makeDelegateComposeResponse(),
    }).dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { tasks: [{ brief: 'do x', reviewPolicy: 'none' }] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
    expect(body[0]?.structuredReport?.filesChanged).toEqual(['x.ts']);
  });

  it('reviewPolicy=full triggers spec + quality + diff reviews via ReviewerEngine', async () => {
    const adapter = mockAdapter({
      turns: [
        // turn 0 — impl
        { assistantText: '```json\n{"summary":"impl","filesChanged":["a.ts"]}\n```', toolCalls: [] },
        // turn 1 — spec review (ReviewerEngine.runSpec calls shell.run)
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        // turn 2 — quality review (ReviewerEngine.runQualityAP calls shell.run)
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        // turn 3 — diff review (ReviewerEngine.runDiff calls shell.run)
        { assistantText: 'APPROVE', toolCalls: [] },
      ],
    });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDelegateParseBrief(),
      compose_response: makeDelegateComposeResponse(),
    });

    // Wire ReviewerEngine through the shell so review turns are consumed
    const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
    const engine = new ReviewerEngine(dispatcher.shell, builder);
    const reviewHandlers = makeReviewHandlers(engine);

    for (const [key, handler] of Object.entries(reviewHandlers)) {
      dispatcher.overrideHandler(key, handler);
    }

    const result = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { tasks: [{ brief: 'do x', reviewPolicy: 'full' }] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('spec review changes_required verdict triggers rework cascade', async () => {
    const adapter = mockAdapter({
      turns: [
        // turn 0 — first impl
        { assistantText: '```json\n{"summary":"first attempt","filesChanged":["a.ts"]}\n```', toolCalls: [] },
        // turn 1 — spec review round 1 returns changes_required
        { assistantText: '```json\n{"verdict":"changes_required","concerns":["missing edge case"]}\n```', toolCalls: [] },
        // turn 2 — rework (shell.run from rework_for_spec_round_1)
        { assistantText: '```json\n{"summary":"fixed","filesChanged":["a.ts"]}\n```', toolCalls: [] },
        // turn 3 — spec review round 2 returns approved
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        // turn 4 — quality review
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        // turn 5 — diff review
        { assistantText: 'APPROVE', toolCalls: [] },
      ],
    });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDelegateParseBrief(),
      compose_response: makeDelegateComposeResponse(),
    });

    const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
    const engine = new ReviewerEngine(dispatcher.shell, builder);
    const reviewHandlers = makeReviewHandlers(engine);

    for (const [key, handler] of Object.entries(reviewHandlers)) {
      dispatcher.overrideHandler(key, handler);
    }
    // Wire rework handlers to actually re-invoke the shell
    dispatcher.overrideHandler('rework_for_spec_round_1', makeReworkHandler(dispatcher.shell));

    const result = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { tasks: [{ brief: 'do x', reviewPolicy: 'full' }] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
    // The final structured report should be from the second (fixed) impl
    expect(body[0]?.structuredReport?.summary).toBe('fixed');
  });

  it('parseVerdict rejects "no concerns" prose as not a concern verdict', async () => {
    const adapter = mockAdapter({
      turns: [
        // impl
        { assistantText: '```json\n{"summary":"done","filesChanged":["x.ts"]}\n```', toolCalls: [] },
        // spec review whose JSON says "approved" but prose says "no concerns about this"
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```\n\nThere are no concerns about this implementation.', toolCalls: [] },
        // quality review
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        // diff review
        { assistantText: 'APPROVE', toolCalls: [] },
      ],
    });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDelegateParseBrief(),
      compose_response: makeDelegateComposeResponse(),
    });

    const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
    const engine = new ReviewerEngine(dispatcher.shell, builder);
    const reviewHandlers = makeReviewHandlers(engine);

    for (const [key, handler] of Object.entries(reviewHandlers)) {
      dispatcher.overrideHandler(key, handler);
    }

    const result = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { tasks: [{ brief: 'do x', reviewPolicy: 'full' }] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    // parseVerdict should extract verdict from the JSON block, not the prose substring
    expect(body[0]?.terminalStatus).toBe('ok');
  });
});
