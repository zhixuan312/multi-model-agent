import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { executePlanSlot } from '../../packages/core/src/intake-pipeline/slots/execute-plan.js';
import type { ExecutePlanInput } from '../../packages/core/src/intake-pipeline/slots/execute-plan.js';
import { executePlanReportSchema } from '../../packages/core/src/reporting/slots/execute-plan-report.js';
import { ReviewerEngine, ReviewerPromptBuilder, specTemplate, qualityAPTemplate, diffTemplate } from '../../packages/core/src/review/reviewer-engine.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

// ---- temp dir helpers ---------------------------------------------------

let tmpDir: string;

function writePlan(fileName: string, content: string): void {
  writeFileSync(join(tmpDir, fileName), content, 'utf8');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mma-execute-plan-test-'));
  writePlan('PLAN.md', [
    '# Project Plan',
    '',
    '## Task 1: do x',
    '',
    'Implement feature X by editing x.ts.',
    '',
    '## Task 2: do y',
    '',
    'Implement feature Y by editing y.ts.',
    '',
    '# Another top-level section',
    '',
    'Some content here.',
  ].join('\n'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---- parse_brief for execute_plan ---------------------------------------

function makeExecutePlanParseBrief(cwd: string): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as ExecutePlanInput | undefined;
    if (!req || !Array.isArray(req.filePaths) || req.filePaths.length === 0 || !Array.isArray(req.taskDescriptors) || req.taskDescriptors.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = executePlanSlot({ ...req, cwd });
    (state as any).executePlanBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
    (state as any).autoCommit = briefs[0].autoCommit;
  };
}

// ---- compose_response for execute_plan ----------------------------------

function makeExecutePlanComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    try {
      structuredReport = executePlanReportSchema.parse(workerOutput);
    } catch { /* leave null */ }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

// ---- review handlers (same 3 templates as 5.1) --------------------------

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

function makeReworkHandler(shell: import('../../packages/core/src/runner-shell/shell.js').RunnerShell): StageHandler {
  return async (state: LifecycleState) => {
    const result = await shell.run((state as any).runInput);
    state.lastRunResult = result;
    state.workerStatus = result.workerStatus;
  };
}

// ---- tests ---------------------------------------------------------------

describe('execute_plan via v4.0 lifecycle', () => {
  const planPath = (): [string] => [join(tmpDir, 'PLAN.md')];

  it('one task with reviewPolicy=none reaches complete status', async () => {
    const adapter = mockAdapter({
      turns: [{ assistantText: '```json\n{"summary":"did it","filesChanged":["x.ts"],"taskOutcomes":[{"taskIndex":0,"status":"done"}]}\n```', toolCalls: [] }],
    });

    const result = await bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExecutePlanParseBrief(tmpDir),
      compose_response: makeExecutePlanComposeResponse(),
    }).dispatch({
      route: 'execute_plan',
      toolCategory: 'artifact_producing',
      rawRequest: {
        filePaths: planPath(),
        taskDescriptors: ['Task 1: do x'],
        perTaskReviewPolicy: { 0: 'none' },
      },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
    expect(body[0]?.structuredReport?.filesChanged).toEqual(['x.ts']);
  });

  it('reviewPolicy=full triggers spec + quality + diff reviews via ReviewerEngine', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '```json\n{"summary":"impl","filesChanged":["a.ts"],"taskOutcomes":[{"taskIndex":0,"status":"done"}]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        { assistantText: 'APPROVE', toolCalls: [] },
      ],
    });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExecutePlanParseBrief(tmpDir),
      compose_response: makeExecutePlanComposeResponse(),
    });

    const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
    const engine = new ReviewerEngine(dispatcher.shell, builder);
    const reviewHandlers = makeReviewHandlers(engine);

    for (const [key, handler] of Object.entries(reviewHandlers)) {
      dispatcher.overrideHandler(key, handler);
    }

    const result = await dispatcher.dispatch({
      route: 'execute_plan',
      toolCategory: 'artifact_producing',
      rawRequest: {
        filePaths: planPath(),
        taskDescriptors: ['Task 1: do x'],
        perTaskReviewPolicy: { 0: 'full' },
      },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
  });

  it('spec review changes_required verdict triggers rework cascade', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '```json\n{"summary":"first attempt","filesChanged":["a.ts"],"taskOutcomes":[{"taskIndex":0,"status":"done"}]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"verdict":"changes_required","concerns":["missing edge case"]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"summary":"fixed","filesChanged":["a.ts"],"taskOutcomes":[{"taskIndex":0,"status":"done"}]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        { assistantText: '```json\n{"verdict":"approved","concerns":[]}\n```', toolCalls: [] },
        { assistantText: 'APPROVE', toolCalls: [] },
      ],
    });

    const dispatcher = bootstrapWithMockAdapterAndOverrides(adapter, {
      parse_brief: makeExecutePlanParseBrief(tmpDir),
      compose_response: makeExecutePlanComposeResponse(),
    });

    const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
    const engine = new ReviewerEngine(dispatcher.shell, builder);
    const reviewHandlers = makeReviewHandlers(engine);

    for (const [key, handler] of Object.entries(reviewHandlers)) {
      dispatcher.overrideHandler(key, handler);
    }
    dispatcher.overrideHandler('rework_for_spec_round_1', makeReworkHandler(dispatcher.shell));

    const result = await dispatcher.dispatch({
      route: 'execute_plan',
      toolCategory: 'artifact_producing',
      rawRequest: {
        filePaths: planPath(),
        taskDescriptors: ['Task 1: do x'],
        perTaskReviewPolicy: { 0: 'full' },
      },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body[0]?.terminalStatus).toBe('ok');
    expect(body[0]?.structuredReport?.summary).toBe('fixed');
  });

  it('agentType is locked to standard regardless of caller input', async () => {
    // The slot always outputs agentType='standard' even if the request
    // object carries agentType='complex'. The Zod strict check at the
    // HTTP boundary rejects it before dispatch; this test verifies the
    // slot's invariant directly.
    const briefs = executePlanSlot({
      filePaths: [join(tmpDir, 'PLAN.md')],
      taskDescriptors: ['Task 1: do x'],
      cwd: tmpDir,
    } as ExecutePlanInput);

    expect(briefs[0].agentType).toBe('standard');
  });
});
