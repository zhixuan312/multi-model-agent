import { describe, expect, it } from 'vitest';
import { runTwoPhasePipeline } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

function baseInput(overrides: Record<string, unknown>) {
  let reviewerOpens = 0;
  const implementer = mockProvider({ sequence: [{ output: '[{"learning":"A","decision":{"kind":"merge","targetNodeId":"0001","reason":"covered"}}]' }] });
  const reviewer = mockProvider({ sequence: [{ output: '{"recorded":[],"failed":[]}' }], onOpen: () => { reviewerOpens += 1; } });
  return {
    input: {
      type: 'journal_record', readerFacing: true, reviewPolicy: 'reviewed',
      implementerSkill: 'impl', reviewerSkill: 'rev',
      implementerProvider: implementer, reviewerProvider: reviewer,
      implementerTier: 'complex', reviewerTier: 'standard',
      taskPayload: '{"records":[{"prompt":"A"}]}', cwd: process.cwd(), sandboxPolicy: 'cwd-only',
      dispatchedTasks: ['[record 1] A'],
      ...overrides,
    } as never,
    reviewerOpens: () => reviewerOpens,
  };
}

describe('two-phase pipeline journal applyDecisions hook', () => {
  it('applies decisions then SKIPS the reviewer when invariants pass and forceReview is false', async () => {
    const t = baseInput({ forceReview: false, applyDecisions: async () => ({ recorded: [{ nodeId: '0001' }], failed: [], invariantsPassed: true }) });
    const res = await runTwoPhasePipeline(t.input);
    expect(t.reviewerOpens()).toBe(0);
    expect(JSON.parse(res.implementerOutput)).toEqual({ recorded: [{ nodeId: '0001' }], failed: [] });
  });
  it('RUNS the reviewer when invariants fail', async () => {
    const t = baseInput({ forceReview: false, applyDecisions: async () => ({ recorded: [], failed: [{ learning: 'A', reason: 'bad' }], invariantsPassed: false }) });
    await runTwoPhasePipeline(t.input);
    expect(t.reviewerOpens()).toBe(1);
  });
  it('RUNS the reviewer when forceReview is true even if invariants pass', async () => {
    const t = baseInput({ forceReview: true, applyDecisions: async () => ({ recorded: [], failed: [], invariantsPassed: true }) });
    await runTwoPhasePipeline(t.input);
    expect(t.reviewerOpens()).toBe(1);
  });
});
