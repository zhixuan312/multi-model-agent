import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { verifySlot } from '../../packages/core/src/intake/brief-compiler-slots/verify.js';
import type { VerifyInput } from '../../packages/core/src/intake/brief-compiler-slots/verify.js';
import { verifyReportSchema } from '../../packages/core/src/reporting/report-parser-slots/verify-report.js';
import { AnnotatorEngine } from '../../packages/core/src/review/annotator-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeVerifyParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as VerifyInput | undefined;
    if (!req || !Array.isArray(req.checklist) || req.checklist.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = verifySlot(req);
    (state as any).verifyBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
  };
}

function makeVerifyComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = verifyReportSchema.parse(workerOutput);
    } catch { /* leave null */ }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

function makeAnnotatorHandler(shell: any, route: string): StageHandler {
  return async (state: LifecycleState): Promise<void> => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';
    const cwd = (state as any).cwd ?? process.cwd();

    const result = await new AnnotatorEngine().annotate(shell, {
      workerOutput,
      brief: state.userMessage ?? '',
      cwd,
      route: route as any,
    });

    state.lastRunResult = {
      ...state.lastRunResult,
      finalAssistantText: result.finalAssistantText,
    } as any;
    state.qualityReviewRound1Verdict = result.verdict;
  };
}

describe('verify_work via v4.0 lifecycle', () => {
  it('does not fire run_verify_command stage', async () => {
    let verifyCommandFired = false;
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"results":[{"item":"x","pass":true,"evidence":"y"}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeVerifyParseBrief(),
      compose_response: makeVerifyComposeResponse(),
    });

    dispatcher.overrideHandler('run_verify_command', () => {
      verifyCommandFired = true;
    });

    await dispatcher.dispatch({
      route: 'verify',
      toolCategory: 'read_only',
      rawRequest: { checklist: ['build passes'] },
    });

    expect(verifyCommandFired).toBe(false);
  });

  it('preserves verify results through annotator pass', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"results":[{"item":"build passes","pass":true,"evidence":"npm test exit 0"},{"item":"lint passes","pass":false,"evidence":"3 warnings"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"results":[{"item":"build passes","pass":true,"evidence":"npm test exit 0","annotatorConfidence":0.9},{"item":"lint passes","pass":false,"evidence":"3 warnings","annotatorConfidence":0.85}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeVerifyParseBrief(),
      compose_response: makeVerifyComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'verify'));

    const result = await dispatcher.dispatch({
      route: 'verify',
      toolCategory: 'read_only',
      rawRequest: { checklist: ['build passes', 'lint passes'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.structuredReport?.results).toHaveLength(2);
  });

  it('annotator produces annotated verdict for read_only verify', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"results":[{"item":"check 1","pass":true,"evidence":"found it"}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"results":[{"item":"check 1","pass":true,"evidence":"found it","annotatorConfidence":0.95}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeVerifyParseBrief(),
      compose_response: makeVerifyComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'verify'));

    const result = await dispatcher.dispatch({
      route: 'verify',
      toolCategory: 'read_only',
      rawRequest: { checklist: ['check 1'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator error does not drop results', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"results":[{"item":"check 1","pass":true,"evidence":"found it"}]}\n```', toolCalls: [] },
      { assistantText: 'unparseable annotator output without json block', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeVerifyParseBrief(),
      compose_response: makeVerifyComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'verify'));

    const result = await dispatcher.dispatch({
      route: 'verify',
      toolCategory: 'read_only',
      rawRequest: { checklist: ['check 1'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('slot builds correct brief from checklist', () => {
    const briefs = verifySlot({
      checklist: ['item a', 'item b', 'item c'],
      cwd: '/tmp/test',
    });

    expect(briefs).toHaveLength(1);
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].reviewPolicy).toBe('quality_only');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[0].cwd).toBe('/tmp/test');
    expect(briefs[0].brief).toContain('item a');
    expect(briefs[0].brief).toContain('item b');
    expect(briefs[0].brief).toContain('item c');
  });

  it('slot defaults cwd when not provided', () => {
    const briefs = verifySlot({ checklist: ['one'] });
    expect(briefs[0].cwd).toBe(process.cwd());
  });

  it('headline template formats results correctly', async () => {
    const { verifyHeadlineTemplate } = await import('../../packages/core/src/reporting/headline-templates/verify.js');
    const headline = verifyHeadlineTemplate.compose({
      report: { results: [{ item: 'x', pass: true, evidence: 'y' }, { item: 'z', pass: false, evidence: 'w' }] },
      status: 'ok',
      taskBrief: 'verify checklist',
    });
    expect(headline).toBe('[ok] verify: 1/2 pass');
  });
});
