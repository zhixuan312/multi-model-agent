import { describe, it, expect, vi } from 'vitest';
import { implementHandler } from '../../../packages/core/src/lifecycle/handlers/task-executor.js';
import { mockState } from '../../fixtures/lifecycle-state.js';
import type { ImplementPayload, RouteName } from '../../../packages/core/src/lifecycle/stage-io.js';

const READ_ROUTES: RouteName[] = ['audit', 'review', 'debug', 'investigate', 'explore'];

function makeMockSession(turn: {
  kind: 'ok'; output: string; costUSD: number; turnsUsed: number; terminationReason: string;
} | {
  kind: 'transport_error'; message: string;
} | {
  kind: 'sandbox_violation'; path: string;
}) {
  return {
    send: vi.fn().mockResolvedValue(turn),
    close: vi.fn(),
  };
}

describe('implementHandler', () => {
  it('returns a StageGate<ImplementPayload> on advance', async () => {
    const session = makeMockSession({
      kind: 'ok',
      output: `Worker prose here.\n\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'done',
        summary: 'did the thing',
        filesChanged: ['x.ts'],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('done');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['x.ts']);
    expect((gate.payload as ImplementPayload).findings).toEqual([]);
    expect(gate.telemetry.stageLabel).toBe('implement');
  });

  it('halts on provider transport failure', async () => {
    const session = {
      send: vi.fn().mockRejectedValue(new Error('5xx error after 3 retries')),
      close: vi.fn(),
    };

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/provider_transport_failure/);
  });

  it('advances with workerSelfAssessment=failed when worker emits failed', async () => {
    const session = makeMockSession({
      kind: 'ok',
      output: `\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'failed',
        summary: 'gave up',
        filesChanged: [],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('failed');
    expect((gate.payload as ImplementPayload).summary).toBe('gave up');
  });

  it('halts on cost_cap_exceeded_without_output when no structured output', async () => {
    const session = makeMockSession({
      kind: 'ok',
      output: 'Worker ran out of budget and produced no structured output',
      costUSD: 5.0,
      turnsUsed: 50,
      terminationReason: 'cost_exceeded',
    });

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toBe('cost_cap_exceeded_without_output');
  });

  it('advances on cost_cap when structured output is present', async () => {
    const session = makeMockSession({
      kind: 'ok',
      output: `Some work done.\n\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'done',
        summary: 'done with partial output',
        filesChanged: ['partial.ts'],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 5.0,
      turnsUsed: 50,
      terminationReason: 'cap_exhausted',
    });

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['partial.ts']);
  });

  it('reads route: fills findings for read routes from prose', async () => {
    const proseWithFinding = `Investigated the codebase.

## Finding 1:
- Claim: The function is missing a null check
- Severity: high
- Category: correctness
- Issue: The function does not handle null input

\`\`\`json
${JSON.stringify({
  workerSelfAssessment: 'done',
  summary: 'investigated',
  filesChanged: [],
  findings: [], citations: [], criteriaSucceeded: ['c1'], criteriaErrors: [], sourcesUsed: [],
})}
\`\`\``;

    const session = makeMockSession({
      kind: 'ok',
      output: proseWithFinding,
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });

    const state = mockState({
      route: 'investigate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    const payload = gate.payload as ImplementPayload;
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.findings[0].claim).toBe('The function is missing a null check');
    expect(payload.findings[0].severity).toBe('high');
    expect(payload.filesChanged).toEqual([]);
  });

  it('halts when session throws a sandbox violation', async () => {
    const session = {
      send: vi.fn().mockRejectedValue(new Error('sandbox policy violation: attempted to write outside cwd')),
      close: vi.fn(),
    };

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/sandbox_violation/);
  });

  it('fills all ImplementPayload fields with defaults when JSON block missing', async () => {
    const session = makeMockSession({
      kind: 'ok',
      output: 'No structured output — plain text response',
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });

    const state = mockState({
      route: 'delegate',
      executionContext: {
        ...mockState().executionContext,
        assignedTier: 'standard',
        getSession: () => session,
      } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    const payload = gate.payload as ImplementPayload;
    expect(payload.workerSelfAssessment).toBe('failed');
    expect(payload.filesChanged).toEqual([]);
    expect(payload.findings).toEqual([]);
    expect(payload.citations).toEqual([]);
    expect(payload.criteriaSucceeded).toEqual([]);
    expect(payload.criteriaErrors).toEqual([]);
    expect(payload.sourcesUsed).toEqual([]);
  });
});