import { describe, it, expect } from 'vitest';
import { AnnotatorEngine } from '../../packages/core/src/engines/annotator-engine.js';
import { RunnerShell } from '../../packages/core/src/runner-shell/shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

describe('AnnotatorEngine', () => {
  it('preserves every implementer finding with claim+evidence and re-judged severity', async () => {
    const implFindings = [
      { category: 'correctness', message: 'a' },
      { category: 'correctness', message: 'b' },
    ];
    const adapter = mockAdapter({
      turns: [
        {
          assistantText:
            '```json\n{"findings":[{"id":"F1","severity":"critical","claim":"a-claim","evidence":"line 5","annotatorConfidence":90},{"id":"F2","severity":"low","claim":"b-claim","evidence":"line 10","annotatorConfidence":40}]}\n```',
          toolCalls: [],
        },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new AnnotatorEngine(shell, { build: () => 'annotate' });
    const out = await engine.annotate(
      implFindings,
      'worker output containing line 5 and line 10',
      { systemPrompt: 'sys', cwd: '/tmp', maxTurns: 1 },
    );
    expect(out.verdict).toBe('annotated');
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0].claim).toBe('a-claim');
    expect(out.findings[0].annotatorConfidence).toBe(90);
    expect(out.findings[0].evidenceGrounded).toBe(true);
  });

  it('marks evidenceGrounded=false when evidence is not in worker output', async () => {
    const adapter = mockAdapter({
      turns: [
        {
          assistantText:
            '```json\n{"findings":[{"id":"F1","severity":"high","claim":"x","evidence":"hallucinated quote","annotatorConfidence":50}]}\n```',
          toolCalls: [],
        },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new AnnotatorEngine(shell, { build: () => 'annotate' });
    const out = await engine.annotate(
      [{ category: 'x', message: 'x' }],
      'worker output without that quote',
      { systemPrompt: 's', cwd: '/tmp', maxTurns: 1 },
    );
    expect(out.findings[0].evidenceGrounded).toBe(false);
  });

  it('throws if annotator drops a finding (invariant violation)', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '```json\n{"findings":[]}\n```', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new AnnotatorEngine(shell, { build: () => 'annotate' });
    await expect(
      engine.annotate(
        [{ category: 'x', message: 'x' }],
        'worker output',
        { systemPrompt: 's', cwd: '/tmp', maxTurns: 1 },
      ),
    ).rejects.toThrow(/dropped findings/);
  });
});
