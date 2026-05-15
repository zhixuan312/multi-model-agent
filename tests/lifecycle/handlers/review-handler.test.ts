import { describe, it, expect, vi } from 'vitest';
import { reviewHandler } from '../../../packages/core/src/lifecycle/handlers/review-handler.js';

function fakeTurn(output: string) {
  return {
    output,
    costUSD: 0.005,
    turns: 1,
  };
}

describe('reviewHandler', () => {
  it('combined verdict approved when both sub-reviewers approve', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved'))
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved'));
    const session = { send } as any;
    const ctx: any = {
      getSession: () => session,
    };
    const state: any = {
      executionContext: ctx,
      task: { brief: { body: 'Test brief body' } },
      config: { reviewPolicy: 'standard' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'standard',
    };
    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('approved');
    expect((gate.payload as any).reviewersSucceeded).toEqual(['spec', 'quality']);
    expect((gate.payload as any).reviewersErrored).toEqual([]);
  });

  it('combined verdict changes_required when one sub-reviewer asks for changes', async () => {
    // Quality-review template format: ## Finding N: + Issue/Severity/Suggestion bullets
    const send = vi.fn()
      .mockResolvedValueOnce(fakeTurn('## Verdict\nchanges_required'))
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved'));
    const session = { send } as any;
    const ctx: any = {
      getSession: () => session,
    };
    const state: any = {
      executionContext: ctx,
      task: { brief: { body: 'Test brief body' } },
      config: { reviewPolicy: 'standard' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'standard',
    };
    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('changes_required');
  });

  it('synthesizes changes_required + parser-failure finding when all sub-reviewers error', async () => {
    // Simulate transport errors by having the mock throw
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('transport error: connection refused'))
      .mockRejectedValueOnce(new Error('transport error: connection refused'));
    const session = { send } as any;
    const ctx: any = {
      getSession: () => session,
    };
    const state: any = {
      executionContext: ctx,
      task: { brief: { body: 'Test brief body' } },
      config: { reviewPolicy: 'standard' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'standard',
    };
    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('changes_required');
    expect((gate.payload as any).reviewersErrored).toHaveLength(2);
    expect((gate.payload as any).findings.length).toBeGreaterThanOrEqual(1);
  });

  it('one reviewer approved, other errored → changes_required', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved'))
      .mockRejectedValueOnce(new Error('transport error: connection refused'));
    const session = { send } as any;
    const ctx: any = {
      getSession: () => session,
    };
    const state: any = {
      executionContext: ctx,
      task: { brief: { body: 'Test brief body' } },
      config: { reviewPolicy: 'standard' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'standard',
    };
    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('changes_required');
    expect((gate.payload as any).reviewersSucceeded).toEqual(['spec']);
    expect((gate.payload as any).reviewersErrored).toHaveLength(1);
  });
});