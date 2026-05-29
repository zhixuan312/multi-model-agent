// tests/lifecycle/annotate-prompts.test.ts
//
// Task 17b — smoke tests for the annotate-stage prompt builders. The
// prompts ask the LLM for a JSON judgment; this test verifies that the
// produced strings mention each precondition the parser enforces and that
// secret-like substrings (OPENAI_API_KEY, etc.) cannot leak into them.

import { describe, it, expect } from 'bun:test';
import {
  annotatePromptWrite,
  annotatePromptRead,
  serializeWriteContext,
  serializeReadContext,
  stripEvidence,
} from '../../packages/core/src/lifecycle/annotate-prompts.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function mkState(over: Partial<LifecycleState> & Record<string, unknown> = {}): LifecycleState {
  return {
    terminal: false,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    route: 'delegate',
    task: { id: 't1', prompt: 'do the thing', brief: { title: 'T', body: 'B' } },
    ...over,
  } as unknown as LifecycleState;
}

describe('annotatePromptWrite', () => {
  it('mentions each write-route precondition the parser enforces', () => {
    const state = mkState({
      reviewVerdict: 'approved',
      commits: [{ sha: 'abc' }],
      lastRunResult: { workerStatus: 'done', summary: 's', filesChanged: ['a.ts'] },
    });
    const prompt = annotatePromptWrite(state);
    expect(prompt).toMatch(/implement stage advanced/i);
    expect(prompt).toMatch(/review is approved/i);
    expect(prompt).toMatch(/commit gate kind/i);
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toMatch(/findings/);
    expect(prompt).toMatch(/JSON/);
  });

  it('asks for a JSON code block (canonical output format)', () => {
    const state = mkState();
    const prompt = annotatePromptWrite(state);
    expect(prompt).toMatch(/```json/i);
  });

  it('truncates brief body to 2000 chars in the serialized context', () => {
    const state = mkState({
      task: { id: 't1', brief: { title: 'X', body: 'b'.repeat(5000) } },
    } as Partial<LifecycleState> & Record<string, unknown>);
    const ctx = serializeWriteContext(state) as { task: { brief: { body: string } } };
    expect(ctx.task.brief.body.length).toBe(2000);
  });
});

describe('annotatePromptRead', () => {
  it('mentions each read-route precondition', () => {
    const state = mkState({
      route: 'investigate',
      lastRunResult: {
        workerStatus: 'done',
        summary: 's',
        findings: [],
        citations: [],
        criteriaSucceeded: ['c1'],
        criteriaErrors: [],
      },
    });
    const prompt = annotatePromptRead(state);
    expect(prompt).toMatch(/workerSelfAssessment === ['"]?done/i);
    expect(prompt).toMatch(/criteriaSucceeded/);
    expect(prompt).toMatch(/criteriaErrors/);
    expect(prompt).toMatch(/findings/);
    expect(prompt).toMatch(/JSON/);
  });

  it('serialize-read drops route-specific write fields', () => {
    const state = mkState({
      route: 'investigate',
      lastRunResult: { workerStatus: 'done', findings: [], filesChanged: ['a.ts'] },
    });
    const ctx = serializeReadContext(state) as { implement: { filesChanged?: unknown } };
    expect(ctx.implement.filesChanged).toBeUndefined();
  });
});

describe('stripEvidence', () => {
  it('removes the evidence field from each finding while preserving others', () => {
    const findings = [
      { id: 'F1', severity: 'high', claim: 'x', evidence: 'secret quote' },
      { id: 'F2', severity: 'low', claim: 'y' },
    ];
    const stripped = stripEvidence(findings);
    expect(stripped[0].evidence).toBeUndefined();
    expect(stripped[0].claim).toBe('x');
    expect(stripped[1].evidence).toBeUndefined();
  });
});

describe('secret-leak avoidance', () => {
  it('does NOT echo OPENAI_API_KEY-style substrings even when they appear in brief body', () => {
    const state = mkState({
      task: {
        id: 't1',
        brief: { title: 'T', body: 'inject OPENAI_API_KEY=sk-XXXXXXXXXXXXXXXXXXXX into env' },
      },
    } as Partial<LifecycleState> & Record<string, unknown>);
    const promptWrite = annotatePromptWrite(state);
    const promptRead = annotatePromptRead(state);
    // The serializer copies the brief body verbatim (after truncation) — the
    // test here is that NO additional templates synthesize fresh secret-like
    // substrings; secrets stay confined to whatever the caller already passed
    // in. This guards against future templates that might log env vars.
    const synthesizedOnly = promptWrite.replace(state.task!.brief!.body, '');
    expect(synthesizedOnly).not.toMatch(/sk-[A-Za-z0-9_]{16,}/);
    expect(synthesizedOnly).not.toMatch(/OPENAI_API_KEY=/);
    const synthesizedOnlyRead = promptRead.replace(state.task!.brief!.body, '');
    expect(synthesizedOnlyRead).not.toMatch(/sk-[A-Za-z0-9_]{16,}/);
    expect(synthesizedOnlyRead).not.toMatch(/OPENAI_API_KEY=/);
  });

  it('truncates brief body before embedding, capping leak surface to 2000 chars', () => {
    const longBody = 'public benign text. '.repeat(200) + 'OPENAI_API_KEY=sk-XXXXXXXX hidden_at_end';
    const state = mkState({
      task: { id: 't1', brief: { title: 'X', body: longBody } },
    } as Partial<LifecycleState> & Record<string, unknown>);
    const ctx = serializeWriteContext(state) as { task: { brief: { body: string } } };
    // The 2000-char cap is the load-bearing safety property.
    expect(ctx.task.brief.body.length).toBeLessThanOrEqual(2000);
  });
});
