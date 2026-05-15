// tests/acceptance/stage-io-annotate-truncation.test.ts
// AC-30: truncation tier-1 (evidence removed) → normal annotate output
// AC-31: truncation tier-2 (summary removed) fires when tier-1 insufficient
// AC-32: truncation tier-3 (Citation.claim removed) fires when tier-2 insufficient
// AC-33: after tier-3, deterministic fallback AnnotatePayload is emitted

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnnotatePayload, LifecycleState, StageGate } from '../../packages/core/src/lifecycle/stage-io.js';
import { mockAnnotateState } from '../fixtures/lifecycle-state.js';
import { annotator } from '../../packages/core/src/lifecycle/handlers/annotator.js';

let emittedTruncationEvents: Array<{ event: string; tier?: number; droppedFieldCount?: number }> = [];
let truncateTier: 1 | 2 | 3 | null = null;

function makeStateWithFindings(findings: Array<{ severity: string; category: string; claim: string; evidence?: string }>, opts: { route?: string; citationClaim?: string; summary?: string } = {}) {
  const state = mockAnnotateState({ route: opts.route as 'delegate' | undefined });
  (state as { lastRunResult?: Record<string, unknown> }).lastRunResult = {
    workerStatus: 'done',
    summary: opts.summary ?? 'Work completed.',
    filesChanged: ['src/foo.ts'],
    findings: findings.map(f => ({ ...f })),
    citations: opts.citationClaim ? [{ file: 'src/foo.ts', lines: '10-15', claim: opts.citationClaim }] : [],
    criteriaSucceeded: ['c1'],
    criteriaErrors: [],
    sourcesUsed: ['src/foo.ts'],
  };
  state.gates['implement'] = {
    outcome: 'advance',
    payload: {
      workerSelfAssessment: 'done', summary: opts.summary ?? 's', filesChanged: ['a.ts'],
      findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
    },
    telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0.01, turnsUsed: 1, stopReason: 'normal' as const },
  } as any;
  return state;
}

async function runAnnotatorWithTruncation(tier: 1 | 2 | 3): Promise<{ gate: StageGate<unknown>; state: LifecycleState }> {
  truncateTier = tier;
  let capturedState: LifecycleState | null = null;

  const state = makeStateWithFindings(
    [
      { severity: 'medium', category: 'style', claim: 'unused variable', evidence: 'const x = 1; // never used' },
    ],
    {
      route: 'delegate',
      citationClaim: 'Variable x is declared but never used',
      summary: 'Summary of the work done.',
    },
  );

  // Spy on the bus to capture annotate_truncation events
  emittedTruncationEvents = [];
  const origEmit = (state.executionContext as any).bus.emit;
  (state.executionContext as any).bus.emit = (e: unknown) => {
    const ev = e as Record<string, unknown>;
    if (ev['event'] === 'annotate_truncation') {
      emittedTruncationEvents.push(ev as { event: string; tier?: number; droppedFieldCount?: number });
    }
    origEmit(e);
  };

  // Set truncation tier via config so the annotator applies it
  (state as { config?: Record<string, unknown> }).config = {
    ...(state.config as Record<string, unknown>),
    truncateAnnotatePromptTier: tier,
  };

  capturedState = state;
  await annotator(state);

  const payload = (state as { annotatePayload?: AnnotatePayload }).annotatePayload;
  const gate: StageGate<AnnotatePayload> = {
    outcome: 'advance',
    payload: payload ?? {
      completed: false,
      message: 'annotator produced no payload',
      findings: [],
      summary: '',
      filesChanged: [],
      commitSha: null,
    },
    telemetry: { stageLabel: 'annotate', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
  };

  return { gate, state };
}

describe.skip('AC-30: truncate tier-1 (evidence removed) → normal output', () => {
  it('tier-1 drops Finding.evidence and emits annotate_truncation event', async () => {
    const { gate } = await runAnnotatorWithTruncation(1);

    expect(gate.outcome).toBe('advance');
    expect(gate.payload.completed).toBe(true);
    // Tier-1 removes evidence; the handler should still produce a successful payload
    expect(gate.payload.findings).toHaveLength(1);

    const truncationEvents = emittedTruncationEvents.filter(e => e.event === 'annotate_truncation');
    expect(truncationEvents.length).toBeGreaterThanOrEqual(1);
    const t1Event = truncationEvents.find(e => e.tier === 1);
    expect(t1Event).toBeDefined();
  });
});

describe.skip('AC-31: truncate tier-2 (summary removed) fires when tier-1 insufficient', () => {
  it('tier-2 drops summary fields and emits annotate_truncation event', async () => {
    const { gate } = await runAnnotatorWithTruncation(2);

    expect(gate.outcome).toBe('advance');
    expect(gate.payload.completed).toBe(true);
    // Tier-2 removes summaries; findings still present (evidence also removed under tier-2)
    expect(gate.payload.summary).toBe('');

    const truncationEvents = emittedTruncationEvents.filter(e => e.event === 'annotate_truncation');
    expect(truncationEvents.some(e => e.tier === 2)).toBe(true);
  });
});

describe.skip('AC-32: truncate tier-3 (Citation.claim removed) fires when tier-2 insufficient', () => {
  it('tier-3 drops Citation.claim and emits annotate_truncation event', async () => {
    const { gate } = await runAnnotatorWithTruncation(3);

    expect(gate.outcome).toBe('advance');
    expect(gate.payload.message).toContain('tier-3');
    expect(gate.payload.findings).toHaveLength(0);
    expect(gate.payload.summary).toBe('');

    const truncationEvents = emittedTruncationEvents.filter(e => e.event === 'annotate_truncation');
    expect(truncationEvents.some(e => e.tier === 3)).toBe(true);
  });
});

describe.skip('AC-33: after tier-3, deterministic fallback AnnotatePayload is emitted', () => {
  it('fallback AnnotatePayload has verbatim message from spec §5.7.3', async () => {
    const state = makeStateWithFindings(
      [{ severity: 'high', category: 'logic', claim: 'off-by-one error', suggestion: 'use >=' }],
      { route: 'delegate', citationClaim: 'Bug here', summary: 'Work done.' },
    );
    state.gates['review'] = {
      outcome: 'advance',
      payload: {
        verdict: 'changes_required',
        findings: [{ severity: 'high', category: 'logic', claim: 'off-by-one error', suggestion: 'use >=', source: 'reviewer' as const }],
        reviewersSucceeded: [],
        reviewersErrored: [],
      },
      telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0.005, turnsUsed: 1, stopReason: 'normal' as const },
    };
    (state as { config?: Record<string, unknown> }).config = {
      ...(state.config as Record<string, unknown>),
      truncateAnnotatePromptTier: 3,
    };

    emittedTruncationEvents = [];
    const origEmit = (state.executionContext as any).bus.emit;
    (state.executionContext as any).bus.emit = (e: unknown) => {
      const ev = e as Record<string, unknown>;
      if (ev['event'] === 'annotate_truncation') {
        emittedTruncationEvents.push(ev as { event: string; tier?: number; droppedFieldCount?: number });
      }
      origEmit(e);
    };

    await annotator(state);
    const payload = (state as { annotatePayload?: AnnotatePayload }).annotatePayload;

    expect(payload).toBeDefined();
    expect(payload!.completed).toBe(false);
    expect(payload!.message).toBe(
      'annotator prompt budget exceeded after tier-3 truncation; verdict computed mechanically from upstream gates',
    );
    // Findings passthrough: review findings carried from upstream gate, not cleared
    expect(payload!.findings).toHaveLength(1);
    expect(payload!.summary).toBe('');

    const truncationEvents = emittedTruncationEvents.filter(e => e.event === 'annotate_truncation');
    expect(truncationEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('fallback commitSha is mechanically derived from upstream gates', async () => {
    const state = makeStateWithFindings([], { route: 'delegate' });
    state.gates['commit'] = {
      outcome: 'advance',
      payload: { kind: 'committed', commitSha: 'abc', commitMessage: 'fix', filesChanged: ['a.ts'], authoredAt: '2026-05-15T00:00:00Z' },
      telemetry: { stageLabel: 'commit', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
    };
    (state as { config?: Record<string, unknown> }).config = {
      ...(state.config as Record<string, unknown>),
      truncateAnnotatePromptTier: 3,
    };

    emittedTruncationEvents = [];
    const origEmit = (state.executionContext as any).bus.emit;
    (state.executionContext as any).bus.emit = (e: unknown) => {
      const ev = e as Record<string, unknown>;
      if (ev['event'] === 'annotate_truncation') {
        emittedTruncationEvents.push(ev as { event: string; tier?: number; droppedFieldCount?: number });
      }
      origEmit(e);
    };

    await annotator(state);
    const payload = (state as { annotatePayload?: AnnotatePayload }).annotatePayload;

    // commitSha is mechanically derived from gates.commit.payload.commitSha, not invented
    expect(payload!.commitSha).toBe('abc');
  });
});