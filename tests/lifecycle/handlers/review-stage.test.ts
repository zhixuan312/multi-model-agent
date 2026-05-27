import { describe, it, expect, vi } from 'bun:test';
import { reviewHandler } from '../../../packages/core/src/lifecycle/handlers/review-stage.js';

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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
    };
    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('changes_required');
    expect((gate.payload as any).reviewersSucceeded).toEqual(['spec']);
    expect((gate.payload as any).reviewersErrored).toHaveLength(1);
  });

  it('passes cumulativeDiff from diffTracker to both prompt builders', async () => {
    const diffContent = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,2 @@\n+new line';
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: vi.fn().mockResolvedValue(diffContent) },
    };
    const gate = await reviewHandler(state);
    expect(state.diffTracker.cumulativeDiff).toHaveBeenCalled();
    expect((gate.payload as any).verdict).toBe('approved');
    // Verify both prompts received the diff in their context
    const callCount = send.mock.calls.length;
    expect(callCount).toBe(2);
    // Both prompts should contain the diff
    for (let i = 0; i < callCount; i++) {
      const prompt = send.mock.calls[i][0] as string;
      expect(prompt).toContain(diffContent);
    }
  });

  it('handles empty diff gracefully when diffTracker returns empty string', async () => {
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: vi.fn().mockResolvedValue('') },
    };
    const gate = await reviewHandler(state);
    expect(state.diffTracker.cumulativeDiff).toHaveBeenCalled();
    // Both prompts should contain the "no diff available" placeholder
    for (let i = 0; i < 2; i++) {
      const prompt = send.mock.calls[i][0] as string;
      expect(prompt).toContain('(no diff available)');
    }
  });

  it('handles diffTracker.cumulativeDiff() throwing an error gracefully', async () => {
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: vi.fn().mockRejectedValue(new Error('diff failed')) },
    };
    const gate = await reviewHandler(state);
    expect(state.diffTracker.cumulativeDiff).toHaveBeenCalled();
    // Should not throw; should render placeholder
    expect((gate.payload as any).verdict).toBe('approved');
    for (let i = 0; i < 2; i++) {
      const prompt = send.mock.calls[i][0] as string;
      expect(prompt).toContain('(no diff available)');
    }
  });

  it('handles missing diffTracker gracefully', async () => {
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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
    };
    const gate = await reviewHandler(state);
    // Should handle gracefully without throwing
    expect((gate.payload as any).verdict).toBe('approved');
    for (let i = 0; i < 2; i++) {
      const prompt = send.mock.calls[i][0] as string;
      expect(prompt).toContain('(no diff available)');
    }
  });

  it('truncates diff by UTF-8 byte length when over SLICE_CAP_BYTES', async () => {
    // Create a large diff that exceeds SLICE_CAP_BYTES (30 KB)
    const SLICE_CAP_BYTES = 30 * 1024;
    const largeString = 'diff line\n'.repeat(4000); // Create a string larger than 30 KB
    const largeDiff = largeString;

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
      config: { reviewPolicy: 'full' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: { summary: 'Test worker summary', filesChanged: ['test.ts'] },
        },
      },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: vi.fn().mockResolvedValue(largeDiff) },
    };

    const gate = await reviewHandler(state);
    expect((gate.payload as any).verdict).toBe('approved');

    // Verify that both prompts received a truncated diff (with marker)
    for (let i = 0; i < 2; i++) {
      const prompt = send.mock.calls[i][0] as string;
      expect(prompt).toContain('[diff truncated]');
      // Verify the prompt length is reasonable (much smaller than the original large diff)
      expect(prompt.length).toBeLessThan(largeDiff.length);
    }
  });
});