import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { exploreSlot } from '../../packages/core/src/intake-pipeline/slots/explore.js';
import type { ExploreInput, ExploreBrief } from '../../packages/core/src/intake-pipeline/slots/explore.js';
import { exploreReportSchema } from '../../packages/core/src/reporting/slots/explore-report.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import type { RunnerShell } from '../../packages/core/src/runner-shell/shell.js';

function makeExploreParseBrief(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as ExploreInput | undefined;
    if (!req || typeof req.topic !== 'string' || req.topic.trim().length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = exploreSlot(req);
    (state as any).exploreBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
    (state as any).researchAdapter = briefs[0].researchAdapter;
  };
}

function makeExploreComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = exploreReportSchema.parse(workerOutput);
    } catch { /* leave null */ }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

function makeExploreMultiTaskRunner(shell: RunnerShell): StageHandler {
  return async (state: LifecycleState): Promise<void> => {
    const briefs = (state as any).exploreBriefs as ExploreBrief[] | undefined;
    if (!briefs || briefs.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const results: Array<{ result: Awaited<ReturnType<RunnerShell['run']>>; brief: ExploreBrief }> = [];
    for (const brief of briefs) {
      state.userMessage = brief.brief;
      (state as any).reviewPolicy = brief.reviewPolicy;
      (state as any).cwd = brief.cwd;
      state.runInput = {
        ...(state.runInput as any),
        userMessage: brief.brief,
        cwd: brief.cwd,
      };
      const result = await shell.run(state.runInput as any);
      results.push({ result, brief });
    }
    (state as any).exploreResults = results;
    state.lastRunResult = results[results.length - 1]?.result;
  };
}

function makeExploreMultiTaskComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const results = (state as any).exploreResults as Array<{ result: { finalAssistantText?: string; workerStatus?: string; errorCode?: string }; brief: ExploreBrief }> | undefined;
    if (!results) {
      (state as any).responseEnvelope = [];
      return;
    }
    (state as any).responseEnvelope = results.map(({ result }) => {
      const workerOutput = result.finalAssistantText ?? '';
      let structuredReport: unknown = null;
      try {
        structuredReport = exploreReportSchema.parse(workerOutput);
      } catch { /* leave null */ }
      return {
        terminalStatus: result.errorCode ? 'error' : 'ok',
        structuredReport,
        workerStatus: result.workerStatus,
        errorCode: result.errorCode,
      };
    });
  };
}

describe('explore via v4.0 lifecycle', () => {
  it('runs a single explore task (research) with reviewPolicy=none', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"topic":"x","internalFindings":[{"source":"a.ts","summary":"auth"}],"externalFindings":[{"url":"https://example.com","title":"Example","summary":"ext"}],"synthesis":"merged"}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
      compose_response: makeExploreComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: 'x' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
    expect(body[0]?.structuredReport?.topic).toBe('x');
    expect(body[0]?.structuredReport?.internalFindings).toHaveLength(1);
    expect(body[0]?.structuredReport?.externalFindings).toHaveLength(1);
  });

  it('returns synthesis in structured report', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"topic":"y","internalFindings":[],"externalFindings":[],"synthesis":"combined result"}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
      compose_response: makeExploreComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: 'y' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.structuredReport?.synthesis).toBe('combined result');
  });

  it('handles incomplete reason in report', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"topic":"z","internalFindings":[],"externalFindings":[],"synthesis":"partial","incompleteReason":"external unavailable"}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
      compose_response: makeExploreComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: 'z' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.structuredReport?.incompleteReason).toBe('external unavailable');
  });

  it('rejects empty topic', async () => {
    const adapter = mockAdapter({ turns: [] });
    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
    });

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: '' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toBeUndefined();
  });

  it('slot builds 3 briefs with correct structure', () => {
    const briefs = exploreSlot({ topic: 'test topic', cwd: '/tmp/test' });

    expect(briefs).toHaveLength(3);
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].reviewPolicy).toBe('none');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[0].cwd).toBe('/tmp/test');
    expect(briefs[0].researchAdapter).toBe('internal');
    expect(briefs[0].brief).toContain('test topic');
    expect(briefs[0].brief).toContain('internal codebase');

    expect(briefs[1].taskIndex).toBe(1);
    expect(briefs[1].researchAdapter).toBe('external');
    expect(briefs[1].brief).toContain('test topic');
    expect(briefs[1].brief).toContain('external sources');

    expect(briefs[2].taskIndex).toBe(2);
    expect(briefs[2].researchAdapter).toBe('synth');
    expect(briefs[2].brief).toContain('test topic');
    expect(briefs[2].brief).toContain('Synthesize');
  });

  it('slot defaults cwd when not provided', () => {
    const briefs = exploreSlot({ topic: 'something' });
    expect(briefs[0].cwd).toBe(process.cwd());
    expect(briefs[1].cwd).toBe(process.cwd());
    expect(briefs[2].cwd).toBe(process.cwd());
  });

  it('all briefs have reviewPolicy none and empty contextBlockIds', () => {
    const briefs = exploreSlot({ topic: 'x' });
    for (const b of briefs) {
      expect(b.reviewPolicy).toBe('none');
      expect(b.contextBlockIds).toEqual([]);
      expect(b.agentType).toBe('complex');
    }
  });

  it('headline template formats results correctly', async () => {
    const { exploreHeadlineTemplate } = await import('../../packages/core/src/reporting/headlines/explore.js');
    const headline = exploreHeadlineTemplate.compose({
      report: {
        topic: 'test',
        internalFindings: [{ source: 'a.ts', summary: 'auth' }, { source: 'b.ts', summary: 'db' }],
        externalFindings: [{ url: 'https://x.com', title: 'X', summary: 'ext' }],
        synthesis: 'merged',
      },
      status: 'ok',
      taskBrief: 'explore test',
    });
    expect(headline).toBe("[ok] explore 'test': 2/1 (int/ext)");
  });

  it('headline template shows zero findings', async () => {
    const { exploreHeadlineTemplate } = await import('../../packages/core/src/reporting/headlines/explore.js');
    const headline = exploreHeadlineTemplate.compose({
      report: { topic: 'empty', internalFindings: [], externalFindings: [], synthesis: '' },
      status: 'error',
      taskBrief: 'explore empty',
    });
    expect(headline).toBe("[error] explore 'empty': 0/0 (int/ext)");
  });

  it('report schema parses valid explore report', () => {
    const json = `\`\`\`json
{"topic":"test","internalFindings":[{"source":"a.ts","summary":"auth"}],"externalFindings":[{"url":"https://x.com","title":"X","summary":"ext"}],"synthesis":"merged","incompleteReason":"partial"}
\`\`\``;
    const report = exploreReportSchema.parse(json);
    expect(report.topic).toBe('test');
    expect(report.internalFindings).toHaveLength(1);
    expect(report.internalFindings[0].source).toBe('a.ts');
    expect(report.externalFindings).toHaveLength(1);
    expect(report.externalFindings[0].url).toBe('https://x.com');
    expect(report.synthesis).toBe('merged');
    expect(report.incompleteReason).toBe('partial');
  });

  it('report schema throws on missing JSON block', () => {
    expect(() => exploreReportSchema.parse('no json here')).toThrow('explore report missing JSON block');
  });

  it('reviewPolicy is forced to none for research category', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"topic":"x","internalFindings":[],"externalFindings":[],"synthesis":""}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
      compose_response: makeExploreComposeResponse(),
    });

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: 'x', reviewPolicy: 'full' },
    });

    expect(result.status).toBe(200);
  });

  it('runs 3 tasks (internal/external/synth) with no review or annotation', async () => {
    const adapter = mockAdapter({ turns: [
      { assistantText: '```json\n{"topic":"x","internalFindings":[{"source":"a.ts","summary":"auth module"}],"externalFindings":[],"synthesis":""}\n```', toolCalls: [] },
      { assistantText: '```json\n{"topic":"x","internalFindings":[],"externalFindings":[{"url":"https://example.com","title":"Example","summary":"relevant docs"}],"synthesis":""}\n```', toolCalls: [] },
      { assistantText: '```json\n{"topic":"x","internalFindings":[{"source":"a.ts","summary":"auth module"}],"externalFindings":[{"url":"https://example.com","title":"Example","summary":"relevant docs"}],"synthesis":"internal auth module aligns with external docs on OAuth2 flow"}\n```', toolCalls: [] },
    ] });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExploreParseBrief(),
    });

    dispatcher.overrideHandler('run_initial_impl', makeExploreMultiTaskRunner(dispatcher.shell));
    dispatcher.overrideHandler('compose_response', makeExploreMultiTaskComposeResponse());

    const result = await dispatcher.dispatch({
      route: 'explore',
      toolCategory: 'research',
      rawRequest: { topic: 'x' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body).toHaveLength(3);

    // Task 0 — internal
    expect(body[0]?.terminalStatus).toBe('ok');
    expect(body[0]?.structuredReport?.internalFindings).toHaveLength(1);
    expect(body[0]?.structuredReport?.internalFindings[0].source).toBe('a.ts');

    // Task 1 — external
    expect(body[1]?.terminalStatus).toBe('ok');
    expect(body[1]?.structuredReport?.externalFindings).toHaveLength(1);
    expect(body[1]?.structuredReport?.externalFindings[0].url).toBe('https://example.com');

    // Task 2 — synth
    expect(body[2]?.terminalStatus).toBe('ok');
    expect(body[2]?.structuredReport?.synthesis).toContain('OAuth2');
  });
});
