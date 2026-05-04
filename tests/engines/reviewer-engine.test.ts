import { describe, it, expect } from 'vitest';
import { ReviewerEngine } from '../../packages/core/src/engines/reviewer-engine.js';
import { RunnerShell } from '../../packages/core/src/runner-shell/shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

describe('ReviewerEngine', () => {
  it('parses approved verdict + empty findings', async () => {
    const adapter = mockAdapter({
      turns: [
        {
          assistantText:
            '```json\n{"verdict":"approved","findings":[],"concernCategories":[],"findingsBySeverity":{"critical":0,"high":0,"medium":0,"low":0}}\n```',
          toolCalls: [],
        },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new ReviewerEngine(shell, { build: () => 'review this' });
    const v = await engine.review('artifact', {
      systemPrompt: 'sys',
      cwd: '/tmp',
      maxTurns: 1,
    });
    expect(v.verdict).toBe('approved');
    expect(v.findings).toHaveLength(0);
  });

  it('parses changes_required + finding with description+evidence', async () => {
    const adapter = mockAdapter({
      turns: [
        {
          assistantText:
            '```json\n{"verdict":"changes_required","findings":[{"severity":"high","category":"incomplete_impl","description":"Missing edge case for empty input","evidence":"handleInput in foo.ts:42 returns early on null"}]}\n```',
          toolCalls: [],
        },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new ReviewerEngine(shell, { build: () => 'review this' });
    const v = await engine.review('artifact', {
      systemPrompt: 'sys',
      cwd: '/tmp',
      maxTurns: 1,
    });
    expect(v.verdict).toBe('changes_required');
    expect(v.findings[0].description).toBe(
      'Missing edge case for empty input',
    );
    expect(v.findings[0].evidence).toContain('foo.ts:42');
    expect(v.concernCategories).toContain('incomplete_impl');
    expect(v.findingsBySeverity.high).toBe(1);
  });

  it('parses concerns verdict (quality-chain rework gate)', async () => {
    const adapter = mockAdapter({
      turns: [
        {
          assistantText:
            '```json\n{"verdict":"concerns","findings":[]}\n```',
          toolCalls: [],
        },
      ],
    });
    const shell = new RunnerShell(adapter);
    const engine = new ReviewerEngine(shell, { build: () => 'review this' });
    const v = await engine.review('artifact', {
      systemPrompt: 'sys',
      cwd: '/tmp',
      maxTurns: 1,
    });
    expect(v.verdict).toBe('concerns');
  });

  it('returns error verdict on transport failure', async () => {
    const adapter = mockAdapter({
      turns: [],
      throwOnTurn: new Error('transport'),
    });
    const shell = new RunnerShell(adapter);
    const engine = new ReviewerEngine(shell, { build: () => 'x' });
    const v = await engine.review('artifact', {
      systemPrompt: 'sys',
      cwd: '/tmp',
      maxTurns: 1,
    });
    expect(v.verdict).toBe('error');
  });
});
