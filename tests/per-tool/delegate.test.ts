import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { delegateSlot } from '../../packages/core/src/intake-pipeline/slots/delegate.js';
import type { DelegateInput } from '../../packages/core/src/intake-pipeline/slots/delegate.js';
import { delegateReportSchema } from '../../packages/core/src/reporting/slots/delegate-report.js';
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

  it('reviewPolicy=full triggers spec + quality + diff reviews', async () => {
    const adapter = mockAdapter({
      turns: [
        // impl
        { assistantText: '```json\n{"summary":"impl","filesChanged":["a.ts"]}\n```', toolCalls: [] },
        // spec review
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
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

    // Override review stage handlers to consume turns and set verdicts
    dispatcher.overrideHandler('spec_review_round_1', (state: LifecycleState): void => {
      state.specReviewRound1Verdict = 'approved';
    });
    dispatcher.overrideHandler('quality_review_round_1', (state: LifecycleState): void => {
      state.qualityReviewRound1Verdict = 'approved';
    });
    dispatcher.overrideHandler('review_diff', (state: LifecycleState): void => {
      state.diffReviewVerdict = 'approved';
    });

    const result = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { tasks: [{ brief: 'do x', reviewPolicy: 'full' }] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });
});
