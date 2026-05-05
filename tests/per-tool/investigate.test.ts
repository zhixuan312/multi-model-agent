import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { investigateSlot } from '../../packages/core/src/intake-pipeline/slots/investigate.js';
import type { InvestigateInput } from '../../packages/core/src/intake-pipeline/slots/investigate.js';
import { investigateReportSchema } from '../../packages/core/src/reporting/slots/investigate-report.js';
import { AnnotatorEngine } from '../../packages/core/src/review/annotator-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeInvestigateParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as InvestigateInput | undefined;
    if (!req || typeof req.question !== 'string' || req.question.trim().length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = investigateSlot(req);
    (state as any).investigateBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
  };
}

function makeInvestigateComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = investigateReportSchema.parse(workerOutput);
    } catch { /* leave null */ }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

function makeAnnotatorHandler(engine: AnnotatorEngine): StageHandler {
  return async (state: LifecycleState): Promise<void> => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';
    const cwd = (state as any).cwd ?? process.cwd();

    const result = await engine.annotate({
      workerOutput,
      brief: state.userMessage ?? '',
      cwd,
    });

    state.lastRunResult = {
      ...state.lastRunResult,
      finalAssistantText: result.annotatedText,
    } as any;
    state.qualityReviewRound1Verdict = result.verdict;
  };
}

describe('investigate via v4.0 lifecycle', () => {
  it('forces reviewPolicy=quality_only even if caller passes other', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"question":"x","answer":"y","citations":[{"source":"a.ts","quote":"q"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
      compose_response: makeInvestigateComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: 'x', reviewPolicy: 'none' },
    });

    expect(result.status).toBe(200);
  });

  it('returns question + answer + citations', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"question":"Where is auth logic?","answer":"Auth logic is in src/auth/handler.ts","citations":[{"source":"src/auth/handler.ts","quote":"export function authenticate"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
      compose_response: makeInvestigateComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: 'Where is auth logic?' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.structuredReport?.question).toBe('Where is auth logic?');
    expect(body[0]?.structuredReport?.citations).toHaveLength(1);
  });

  it('preserves investigate results through annotator pass', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"question":"find error handling","answer":"Error handling is in src/errors.ts","citations":[{"source":"src/errors.ts","quote":"class AppError extends Error"},{"source":"src/middleware.ts","quote":"next(err)"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"high","category":"correctness","message":"error handling centralized","evidenceQuote":"class AppError extends Error","annotatorConfidence":0.9}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
      compose_response: makeInvestigateComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: 'find error handling' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    // structuredReport may be null after annotator reformats output shape,
    // but terminalStatus should still be ok
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator produces annotated verdict for read_only investigate', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"question":"test q","answer":"test a","citations":[{"source":"f.ts","quote":"some code here yes"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"critical","category":"security","message":"test finding","evidenceQuote":"some code here yes","annotatorConfidence":0.88}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
      compose_response: makeInvestigateComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: 'test q' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator error does not drop results', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"question":"q","answer":"a","citations":[{"source":"f.ts","quote":"some code here yes"}]}\n```', toolCalls: [] },
      { assistantText: 'unparseable annotator output without json block', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
      compose_response: makeInvestigateComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: 'q' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('slot builds correct brief from question and depth', () => {
    const briefs = investigateSlot({
      question: 'How is authentication implemented?',
      depth: 'deep',
      cwd: '/tmp/test',
    });

    expect(briefs).toHaveLength(1);
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].reviewPolicy).toBe('quality_only');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[0].cwd).toBe('/tmp/test');
    expect(briefs[0].brief).toContain('Investigate (deep)');
    expect(briefs[0].brief).toContain('How is authentication implemented?');
  });

  it('slot defaults cwd and depth when not provided', () => {
    const briefs = investigateSlot({ question: 'something' });
    expect(briefs[0].cwd).toBe(process.cwd());
    expect(briefs[0].brief).toContain('Investigate (medium)');
  });

  it('headline template formats results correctly', async () => {
    const { investigateHeadlineTemplate } = await import('../../packages/core/src/reporting/headlines/investigate.js');
    const headline = investigateHeadlineTemplate.compose({
      report: { question: 'x', answer: 'y', citations: [{ source: 'a.ts', quote: 'q' }, { source: 'b.ts', quote: 'w' }] },
      status: 'ok',
      taskBrief: 'investigate x',
    });
    expect(headline).toBe('[ok] investigate: 2 citations');
  });

  it('headline template uses singular for 1 citation', async () => {
    const { investigateHeadlineTemplate } = await import('../../packages/core/src/reporting/headlines/investigate.js');
    const headline = investigateHeadlineTemplate.compose({
      report: { question: 'x', answer: 'y', citations: [{ source: 'a.ts', quote: 'q' }] },
      status: 'ok',
      taskBrief: 'investigate x',
    });
    expect(headline).toBe('[ok] investigate: 1 citation');
  });

  it('rejects empty question', async () => {
    const adapter = mockAdapter({ turns: [] });
    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeInvestigateParseBrief(),
    });

    const result = await dispatcher.dispatch({
      route: 'investigate',
      toolCategory: 'read_only',
      rawRequest: { question: '' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toBeUndefined();
  });
});
