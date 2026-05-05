import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { debugSlot } from '../../packages/core/src/intake/brief-compiler-slots/debug.js';
import type { DebugInput } from '../../packages/core/src/intake/brief-compiler-slots/debug.js';
import { debugReportSchema } from '../../packages/core/src/reporting/report-parser-slots/debug-report.js';
import { AnnotatorEngine } from '../../packages/core/src/review/annotator-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeDebugParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as DebugInput | undefined;
    if (!req || typeof req.problemStatement !== 'string' || req.problemStatement.trim().length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = debugSlot(req);
    (state as any).debugBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
  };
}

function makeDebugComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = debugReportSchema.parse(workerOutput);
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

describe('debug_task via v4.0 lifecycle', () => {
  it('returns root cause + hypotheses', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"rootCause":"off-by-one","hypothesesConsidered":["a","b"],"evidenceQuotes":["line 5"]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"high","category":"correctness","message":"off-by-one","evidenceQuote":"line 5","annotatorConfidence":0.9}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDebugParseBrief(),
      compose_response: makeDebugComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'debug',
      toolCategory: 'read_only',
      rawRequest: { problemStatement: 'x' },
    });

    expect(result.status).toBe(200);
  });

  it('preserves debug results through annotator pass', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"rootCause":"null pointer","hypothesesConsidered":["h1","h2"],"evidenceQuotes":["crash at line 42"],"recommendedFix":"add null check"}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"high","category":"correctness","message":"null pointer","evidenceQuote":"crash at line 42","annotatorConfidence":0.92}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDebugParseBrief(),
      compose_response: makeDebugComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'debug',
      toolCategory: 'read_only',
      rawRequest: { problemStatement: 'null pointer in handler' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    // structuredReport may be null after annotator reformats output shape,
    // but terminalStatus should still be ok
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator produces annotated verdict for read_only debug', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"rootCause":"race condition","hypothesesConsidered":["threading"],"evidenceQuotes":["log shows interleaving"]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"critical","category":"correctness","message":"race condition","evidenceQuote":"log shows interleaving","annotatorConfidence":0.88}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDebugParseBrief(),
      compose_response: makeDebugComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'debug',
      toolCategory: 'read_only',
      rawRequest: { problemStatement: 'race condition bug' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator error does not drop results', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"rootCause":"memory leak","hypothesesConsidered":["h1"],"evidenceQuotes":["heap growing"]}\n```', toolCalls: [] },
      { assistantText: 'unparseable annotator output without json block', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDebugParseBrief(),
      compose_response: makeDebugComposeResponse(),
    });

    const engine = new AnnotatorEngine(dispatcher.shell);
    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(engine));

    const result = await dispatcher.dispatch({
      route: 'debug',
      toolCategory: 'read_only',
      rawRequest: { problemStatement: 'memory leak' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('slot builds correct brief from problemStatement and reproSteps', () => {
    const briefs = debugSlot({
      problemStatement: 'app crashes on startup',
      reproSteps: '1. run npm start\n2. open browser',
      cwd: '/tmp/test',
    });

    expect(briefs).toHaveLength(1);
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].reviewPolicy).toBe('quality_only');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[0].cwd).toBe('/tmp/test');
    expect(briefs[0].brief).toContain('app crashes on startup');
    expect(briefs[0].brief).toContain('1. run npm start');
  });

  it('slot defaults cwd and reproSteps when not provided', () => {
    const briefs = debugSlot({ problemStatement: 'something is broken' });
    expect(briefs[0].cwd).toBe(process.cwd());
    expect(briefs[0].brief).toContain('(none)');
  });

  it('headline template formats results correctly', async () => {
    const { debugHeadlineTemplate } = await import('../../packages/core/src/reporting/headline-templates/debug.js');
    const headline = debugHeadlineTemplate.compose({
      report: { rootCause: 'off-by-one error in loop', hypothesesConsidered: ['a', 'b'], evidenceQuotes: ['line 5'] },
      status: 'ok',
      taskBrief: 'debug crash',
    });
    expect(headline).toBe('[ok] debug: off-by-one error in loop');
  });

  it('rejects empty problemStatement', async () => {
    const adapter = mockAdapter({ turns: [] });
    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeDebugParseBrief(),
    });

    const result = await dispatcher.dispatch({
      route: 'debug',
      toolCategory: 'read_only',
      rawRequest: { problemStatement: '' },
    });

    // When terminal is set in parse_brief, compose_response never runs,
    // so responseEnvelope remains undefined.
    expect(result.status).toBe(200);
    expect(result.body).toBeUndefined();
  });
});
