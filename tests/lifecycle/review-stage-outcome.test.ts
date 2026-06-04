import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewHandler } from '../../packages/core/src/lifecycle/handlers/review-stage.js';

let mockReviewerTurns: Array<ReturnType<typeof fakeReviewerTurn>> = [];
let turnIndex = 0;

vi.mock('../../packages/core/src/lifecycle/handlers/tier-policy.js', () => ({
  invertedReviewerTier: vi.fn(() => 'complex'),
}));

function fakeReviewerTurn(verdict: 'approved' | 'changes_required', findings = '') {
  const findingsSection = findings ? `## Findings\n${findings}` : '## Findings\n(none)';
  return {
    output: `## Verdict\n${verdict}\n\n${findingsSection}\n\n## Outcome\n${verdict === 'approved' ? 'clean' : 'found'}`,
    costUSD: 0, turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  };
}

function makeState(reviewerTurns: Array<ReturnType<typeof fakeReviewerTurn>>) {
  mockReviewerTurns = reviewerTurns;
  turnIndex = 0;
  return {
    reviewPolicy: 'full',
    gates: { implement: { payload: { summary: 's', filesChanged: [] } } },
    task: { brief: 'b' },
    executionContext: {
      assignedTier: 'standard',
      providers: { standard: {}, complex: {} },
      getSession: vi.fn(() => ({
        send: vi.fn().mockImplementation(() => {
          const turn = mockReviewerTurns[turnIndex++];
          return Promise.resolve(turn);
        }),
      })),
    },
    lastRunResult: { stageStats: {} },
  } as any;
}

describe('reviewHandler — findingsOutcome aggregation', () => {
  it('any sub-reviewer found → stage outcome = found', async () => {
    const state = makeState([
      fakeReviewerTurn('approved'),                          // spec: clean
      fakeReviewerTurn('changes_required', '## Finding 1: x\n- Severity: high\n- Category: c\n- Evidence: y\n- Suggestion: z'), // quality: found
    ]);
    const gate = await reviewHandler(state);
    expect((gate.payload as any).findingsOutcome).toBe('found');
  });

  it('both sub-reviewers clean → stage outcome = clean', async () => {
    const state = makeState([fakeReviewerTurn('approved'), fakeReviewerTurn('approved')]);
    const gate = await reviewHandler(state);
    expect((gate.payload as any).findingsOutcome).toBe('clean');
  });

  it('outcome stored on stageStats via mergeStageStats', async () => {
    const state = makeState([fakeReviewerTurn('approved'), fakeReviewerTurn('approved')]);
    await reviewHandler(state);
    const reviewStats = state.lastRunResult.stageStats.review;
    expect(reviewStats.findingsOutcome).toBe('clean');
  });
});
