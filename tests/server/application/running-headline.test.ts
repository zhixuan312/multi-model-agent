import { describe, it, expect, vi } from 'vitest';
import { headlineForEvent, attachHeadlineProducer } from '../../../packages/server/src/application/headline-from-events.js';
import { EnvelopeBus } from '../../../packages/core/src/events/envelope-bus.js';

/**
 * `runningHeadline` shipped readable on both wires in Flow 1 and was written by NOTHING —
 * `TaskRegistry.setHeadline` had zero production callers. Every progress view, including the
 * Claude Desktop execution monitor, therefore showed a phase name and a clock: a task sits in
 * `implementing` for minutes, and "implementing" does not distinguish reading files from
 * running tests from being stuck.
 *
 * These tests cover BOTH runners deliberately. Codex and Claude emit different event names for
 * the same activity, and a headline that worked on only one would read as an intermittent bug
 * rather than a missing case.
 */
describe('running headline: mapping provider events to one human line', () => {
  it('describes a Claude tool call with its target', () => {
    expect(headlineForEvent({ event: 'claude_tool_call', tool: 'Read', input: 'packages/core/src/index.ts' }))
      .toBe('Read: packages/core/src/index.ts');
  });

  it('describes a codex command, unwrapping the bash -lc envelope', () => {
    const headline = headlineForEvent({
      event: 'codex_command_started',
      command: '/bin/bash -lc "rg -n \'cancel|abort\' packages/server/src && nl -ba foo.ts"',
    });
    // The wrapper and the chained second command are noise at this width.
    expect(headline).toMatch(/^Running rg -n/);
    expect(headline).not.toContain('bash');
    expect(headline).not.toContain('nl -ba');
  });

  it('uses the first sentence of agent narration on both runners', () => {
    const long = 'The core path is now located. I will next check the provider teardown and then summarise.';
    expect(headlineForEvent({ event: 'codex_agent_message', preview: long }))
      .toBe('The core path is now located.');
    expect(headlineForEvent({ event: 'claude_text_emission', preview: long }))
      .toBe('The core path is now located.');
  });

  it('names the tool target instead of dumping its JSON input', () => {
    // `Read: {"file_path":"/Users/…` spends the whole width on punctuation and shared prefix.
    expect(headlineForEvent({
      event: 'claude_tool_call', tool: 'Read',
      input: JSON.stringify({ file_path: 'packages/core/src/events/envelope-bus.ts' }),
    })).toBe('Read: packages/core/src/events/envelope-bus.ts');
    expect(headlineForEvent({
      event: 'claude_tool_call', tool: 'Grep', input: JSON.stringify({ pattern: 'abortSignal' }),
    })).toBe('Grep: abortSignal');
  });

  it('keeps the identifying tail of a long absolute path', () => {
    const headline = headlineForEvent({
      event: 'claude_tool_call', tool: 'Read',
      input: JSON.stringify({ file_path: `/Users/someone/${'deep/'.repeat(20)}target.ts` }),
    })!;
    expect(headline).toContain('target.ts');
    expect(headline.length).toBeLessThanOrEqual(72);
  });

  it('ignores the structured report arriving on the narration channel', () => {
    // The final answer is JSON that happens to ride the agent-message event. A headline
    // reading `{"answer":"EnvelopeBus is…` is the RESULT, truncated into gibberish, in the
    // slot reserved for what the worker is doing.
    expect(headlineForEvent({
      event: 'codex_agent_message',
      preview: '{"answer":"EnvelopeBus is defined in packages/core/src/events/envelope-bus.ts"}',
    })).toBeNull();
  });

  it('clips to one line rather than emitting a log record', () => {
    const headline = headlineForEvent({ event: 'claude_tool_call', tool: 'Bash', input: 'x'.repeat(500) })!;
    expect(headline.length).toBeLessThanOrEqual(72);
    expect(headline.endsWith('…')).toBe(true);
  });

  it('returns null for events that say nothing worth showing', () => {
    expect(headlineForEvent({ event: 'codex_turn_started' })).toBeNull();
    expect(headlineForEvent({ event: 'claude_tool_call' })).toBeNull(); // no tool name
    expect(headlineForEvent({})).toBeNull();
    expect(headlineForEvent({ event: 'codex_agent_message', preview: 'ok' })).toBeNull(); // too short
  });
});

describe('running headline: bus wiring', () => {
  /**
   * The bus field is `taskId`. The daemon log shows `task_id=` because the stderr formatter
   * snake-cases keys on the way out — and an earlier version of this test used the LOG
   * spelling, so it passed green while the production path silently dropped every event. The
   * log looked like proof the field was present; it was proof the formatter renames it.
   */
  it('reads the camelCase bus field, not the snake_case log rendering', () => {
    const bus = new EnvelopeBus();
    const s = sink();
    attachHeadlineProducer(bus, s);
    bus.emitPlainEntry({
      ts: '2026-01-01T00:00:00.000Z', kind: 'provider_event',
      fields: { event: 'codex_command_started', command: 'rg foo', taskId: 'camel' },
    });
    expect(s.calls.map(([id]) => id)).toEqual(['camel']);
  });

  function sink() {
    const calls: Array<[string, string]> = [];
    return { calls, setHeadline: (id: string, h: string) => { calls.push([id, h]); } };
  }

  it('sets the headline for the task the event belongs to', () => {
    const bus = new EnvelopeBus();
    const s = sink();
    attachHeadlineProducer(bus, s);
    bus.emitPlainEntry({
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'provider_event',
      fields: { event: 'claude_tool_call', tool: 'Grep', input: 'abort', taskId: 'task-9' },
    });
    expect(s.calls).toEqual([['task-9', 'Grep: abort']]);
  });

  it('ignores events with no task and non-provider entries', () => {
    const bus = new EnvelopeBus();
    const s = sink();
    attachHeadlineProducer(bus, s);
    bus.emitPlainEntry({ ts: '2026-01-01T00:00:00.000Z', kind: 'provider_event', fields: { event: 'claude_tool_call', tool: 'Read' } });
    bus.emitPlainEntry({ ts: '2026-01-01T00:00:00.000Z', kind: 'server_started', fields: { taskId: 't' } });
    expect(s.calls).toEqual([]);
  });

  it('never lets a headline failure break the bus', () => {
    const bus = new EnvelopeBus();
    const exploding = { setHeadline: () => { throw new Error('boom'); } };
    attachHeadlineProducer(bus, exploding);
    const other = { name: 'other', receive: vi.fn() };
    bus.subscribe(other);
    // A headline is decoration. An exception here would surface in the bus's subscriber loop
    // and disrupt logging and telemetry for a cosmetic feature.
    expect(() => bus.emitPlainEntry({
      ts: '2026-01-01T00:00:00.000Z', kind: 'provider_event',
      fields: { event: 'claude_tool_call', tool: 'Read', taskId: 't1' },
    })).not.toThrow();
    expect(other.receive).toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const bus = new EnvelopeBus();
    const s = sink();
    const detach = attachHeadlineProducer(bus, s);
    detach();
    bus.emitPlainEntry({
      ts: '2026-01-01T00:00:00.000Z', kind: 'provider_event',
      fields: { event: 'claude_tool_call', tool: 'Read', input: 'x.ts', taskId: 't1' },
    });
    expect(s.calls).toEqual([]);
  });
});
