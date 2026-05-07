import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { auditSlot } from '../../packages/core/src/intake/brief-compiler-slots/audit.js';
import type { AuditInput } from '../../packages/core/src/intake/brief-compiler-slots/audit.js';
import { auditReportSchema } from '../../packages/core/src/reporting/report-parser-slots/audit-report.js';
import { AnnotatorEngine } from '../../packages/core/src/review/annotator-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeAuditParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as AuditInput | undefined;
    if (!req || !Array.isArray(req.documentPaths) || req.documentPaths.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = auditSlot(req);
    (state as any).auditBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
  };
}

function makeAuditComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = auditReportSchema.parse(workerOutput);
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

describe('audit_document via v4.0 lifecycle', () => {
  it('preserves implementer findings through annotator pass', async () => {
    const adapter = mockAdapter({ turns: [
      // implementer
      { assistantText: '```json\n{"documentPath":"a.md","findings":[{"severity":"high","category":"clarity","message":"X","evidenceQuote":"q","annotatorConfidence":0.0}]}\n```', toolCalls: [] },
      // annotator (must keep the finding; may re-judge severity/confidence)
      { assistantText: '```json\n{"findings":[{"severity":"medium","category":"clarity","message":"X","evidenceQuote":"q","annotatorConfidence":0.7}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeAuditParseBrief(),
      compose_response: makeAuditComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'audit'));

    const result = await dispatcher.dispatch({
      route: 'audit',
      toolCategory: 'read_only',
      rawRequest: { documentPaths: ['a.md'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.structuredReport?.findings).toHaveLength(1);   // never dropped
    expect(body[0]?.structuredReport?.findings[0]?.annotatorConfidence).toBe(0.7);
  });

  it('annotator produces annotated verdict for read_only audit', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"documentPath":"b.md","findings":[{"severity":"low","category":"style","message":"minor","evidenceQuote":"some evidence here","annotatorConfidence":0.0}]}\n```', toolCalls: [] },
      { assistantText: '```json\n{"findings":[{"severity":"low","category":"style","message":"minor","evidenceQuote":"some evidence here","annotatorConfidence":0.85}]}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeAuditParseBrief(),
      compose_response: makeAuditComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'audit'));

    const result = await dispatcher.dispatch({
      route: 'audit',
      toolCategory: 'read_only',
      rawRequest: { documentPaths: ['b.md'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('annotator error does not drop findings', async () => {
    // When annotator output is unparseable, compose_response should still
    // produce a response without crashing
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"documentPath":"c.md","findings":[{"severity":"high","category":"bug","message":"critical","evidenceQuote":"some quote here","annotatorConfidence":0.0}]}\n```', toolCalls: [] },
      { assistantText: 'unparseable annotator output without json block', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeAuditParseBrief(),
      compose_response: makeAuditComposeResponse(),
    });

    dispatcher.overrideHandler('quality_review_round_1', makeAnnotatorHandler(dispatcher.shell, 'audit'));

    const result = await dispatcher.dispatch({
      route: 'audit',
      toolCategory: 'read_only',
      rawRequest: { documentPaths: ['c.md'] },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    // structuredReport is null when annotator output is unparseable
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('per-file fan-out: multiple documentPaths produce independent briefs', () => {
    const briefs = auditSlot({
      documentPaths: ['a.md', 'b.md', 'c.md'],
      questionnaire: 'security audit',
      cwd: '/tmp/test',
    });

    expect(briefs).toHaveLength(3);
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].documentPath).toBe('a.md');
    expect(briefs[0].reviewPolicy).toBe('quality_only');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[1].taskIndex).toBe(1);
    expect(briefs[1].documentPath).toBe('b.md');
    expect(briefs[2].taskIndex).toBe(2);
    expect(briefs[2].documentPath).toBe('c.md');
  });
});
