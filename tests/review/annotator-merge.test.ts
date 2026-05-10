import { describe, it, expect, vi } from 'vitest';
import { AnnotatorEngine } from '../../packages/core/src/review/annotator-engine.js';
import type { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';

function makeShell(captured: { prompt?: string }): RunnerShell {
  return {
    run: vi.fn(async (input: { systemPrompt: string }) => {
      captured.prompt = input.systemPrompt;
      return {
        finalAssistantText: '```json\n[]\n```',
        workerStatus: 'done' as const,
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 50, cachedReadTokens: 150, cachedNonReadTokens: 0 },
        turns: 1,
        durationMs: 50,
        filesRead: [],
        filesWritten: [],
        costUSD: 0.01,
      };
    }),
  } as unknown as RunnerShell;
}

describe('AnnotatorEngine merge mode (multiple workerOutputs)', () => {
  it('emits the merge instructions block when N > 1', async () => {
    const cap: { prompt?: string } = {};
    const engine = new AnnotatorEngine();
    await engine.annotate(makeShell(cap), {
      workerOutputs: [
        { criterion: 'criterion 1 — A', narrative: '## Finding 1: shared bug at file.ts:10' },
        { criterion: 'criterion 2 — B', narrative: '## Finding 1: same shared bug from another angle' },
      ],
      brief: 'Audit for security issues.',
      cwd: '/tmp',
      route: 'audit',
    });
    expect(cap.prompt).toBeDefined();
    expect(cap.prompt!).toContain('Merge instructions');
    expect(cap.prompt!).toContain('criterion 1 — A');
    expect(cap.prompt!).toContain('criterion 2 — B');
    expect(cap.prompt!).toContain('Recalibrate severity');
  });

  it('drops "No findings for this criterion." narratives before sending to the model', async () => {
    const cap: { prompt?: string } = {};
    const engine = new AnnotatorEngine();
    await engine.annotate(makeShell(cap), {
      workerOutputs: [
        { criterion: 'criterion 1', narrative: 'No findings for this criterion.' },
        { criterion: 'criterion 2', narrative: '## Finding 1: real issue at x.ts:5' },
      ],
      brief: 'b',
      cwd: '/tmp',
      route: 'audit',
    });
    // The empty-result narrative should not appear in the prompt body
    expect(cap.prompt).toBeDefined();
    expect(cap.prompt!).not.toContain('No findings for this criterion.');
    expect(cap.prompt!).toContain('## Finding 1: real issue');
  });

  it('synthesizes a placeholder narrative when ALL inputs are empty sentinels', async () => {
    const cap: { prompt?: string } = {};
    const engine = new AnnotatorEngine();
    const result = await engine.annotate(makeShell(cap), {
      workerOutputs: [
        { criterion: 'criterion 1', narrative: 'No findings for this criterion.' },
        { criterion: 'criterion 2', narrative: 'No findings for this criterion.' },
      ],
      brief: 'b',
      cwd: '/tmp',
      route: 'audit',
    });
    // The annotator still runs (returns []) and the placeholder is mentioned
    expect(cap.prompt!).toContain('all sub-workers reported no findings');
    expect(result.annotatedFindings).toEqual([]);
  });

  it('single-narrative input (N=1) does NOT emit the merge instructions block', async () => {
    const cap: { prompt?: string } = {};
    const engine = new AnnotatorEngine();
    await engine.annotate(makeShell(cap), {
      workerOutputs: [
        { criterion: 'all criteria', narrative: '## Finding 1: solo' },
      ],
      brief: 'b',
      cwd: '/tmp',
      route: 'audit',
    });
    expect(cap.prompt).toBeDefined();
    expect(cap.prompt!).not.toContain('Merge instructions');
    expect(cap.prompt!).toContain('## Finding 1: solo');
  });
});
