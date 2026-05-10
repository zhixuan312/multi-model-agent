import { describe, it, expect } from 'vitest';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

/**
 * 4.2.3+ — `runner_response_received` events now carry `assistantText`
 * (capped at 16 KB) so the verbose JSONL log captures reviewer rejection
 * text and other narrative detail. Before this fix, only
 * `assistantTextLen` was on the event, making it impossible to tell from
 * the log alone WHY a spec/quality review rejected.
 */
describe('runner-shell emits assistantText on runner_response_received (4.2.3+)', () => {
  function captureEvents(): { events: Record<string, unknown>[]; bus: { emit: (e: Record<string, unknown>) => void } } {
    const events: Record<string, unknown>[] = [];
    return { events, bus: { emit: (e) => events.push(e) } };
  }

  it('short reviewer text is included verbatim', async () => {
    const { events, bus } = captureEvents();
    const adapter = mockAdapter({
      turns: [
        { assistantText: 'changes_required: section 1 is unclear about retry policy', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [],
      maxTurns: 1, cwd: '/tmp',
      bus,
    });
    const responseEvent = events.find(e => e.event === 'runner_response_received');
    expect(responseEvent).toBeDefined();
    expect(responseEvent!.assistantText).toBe('changes_required: section 1 is unclear about retry policy');
    expect(responseEvent!.assistantTextLen).toBe(57);
    expect(responseEvent!.assistantTextTruncated).toBeUndefined();
  });

  it('text > 16 KB is truncated and flagged with assistantTextTruncated', async () => {
    const big = 'x'.repeat(20_000);
    const { events, bus } = captureEvents();
    const adapter = mockAdapter({
      turns: [{ assistantText: big, toolCalls: [] }],
    });
    const shell = new RunnerShell(adapter);
    await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [],
      maxTurns: 1, cwd: '/tmp',
      bus,
    });
    const e = events.find(ev => ev.event === 'runner_response_received');
    expect(e).toBeDefined();
    expect((e!.assistantText as string).length).toBe(16 * 1024);
    expect(e!.assistantTextLen).toBe(20_000); // ORIGINAL length, not truncated
    expect(e!.assistantTextTruncated).toBe(true);
  });

  it('empty text is omitted (no key on the event)', async () => {
    const { events, bus } = captureEvents();
    const adapter = mockAdapter({
      turns: [{ assistantText: '', toolCalls: [{ name: 'noop', input: {} }] }],
      // 4.0.3 regression: empty + no tool calls would error; give one tool call.
    });
    const shell = new RunnerShell(adapter);
    await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [{ name: 'noop', description: '', schema: {}, execute: async () => null }],
      maxTurns: 1, cwd: '/tmp',
      bus,
    });
    const e = events.find(ev => ev.event === 'runner_response_received');
    expect(e).toBeDefined();
    expect('assistantText' in (e as object)).toBe(false);
    expect(e!.assistantTextLen).toBe(0);
  });
});
