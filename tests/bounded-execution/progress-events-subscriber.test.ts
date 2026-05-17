import { describe, it, expect, beforeEach } from 'vitest';
import { startProgressEventsSubscriber } from '../../packages/core/src/bounded-execution/progress-events-subscriber.js';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';

interface TrackerCall {
  method: 'recordFileRead' | 'recordFileWrite' | 'recordToolCall' | 'markEvent';
  arg?: 'llm' | 'tool' | 'text';
}

function makeStubTracker() {
  const calls: TrackerCall[] = [];
  return {
    recordFileRead: () => calls.push({ method: 'recordFileRead' }),
    recordFileWrite: () => calls.push({ method: 'recordFileWrite' }),
    recordToolCall: () => calls.push({ method: 'recordToolCall' }),
    markEvent: (kind: 'llm' | 'tool' | 'text') => calls.push({ method: 'markEvent', arg: kind }),
    calls,
  };
}

describe('progress-events-subscriber', () => {
  let bus: EventEmitter;
  beforeEach(() => {
    bus = new EventEmitter();
  });

  it('claude_tool_call(Read) increments filesRead, toolCalls, marks tool event', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'claude_tool_call', tool: 'Read', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([
      { method: 'recordToolCall' },
      { method: 'recordFileRead' },
      { method: 'markEvent', arg: 'tool' },
    ]);
    stop();
  });

  it('claude_tool_call(Write) increments filesWritten + toolCalls', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'claude_tool_call', tool: 'Edit', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([
      { method: 'recordToolCall' },
      { method: 'recordFileWrite' },
      { method: 'markEvent', arg: 'tool' },
    ]);
    stop();
  });

  it('claude_tool_call(Bash) only increments toolCalls', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'claude_tool_call', tool: 'Bash', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([
      { method: 'recordToolCall' },
      { method: 'markEvent', arg: 'tool' },
    ]);
    stop();
  });

  it('codex_command_completed and codex_file_change increment expected counters', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'codex_command_completed', batchId: 'b1', taskIndex: 0 });
    bus.emit({ event: 'codex_file_change', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([
      { method: 'recordToolCall' },
      { method: 'markEvent', arg: 'tool' },
      { method: 'recordFileWrite' },
      { method: 'markEvent', arg: 'tool' },
    ]);
    stop();
  });

  it('text and turn events only mark idle timers (no counter increments)', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'claude_text_emission', batchId: 'b1', taskIndex: 0 });
    bus.emit({ event: 'claude_turn_started', batchId: 'b1', taskIndex: 0 });
    bus.emit({ event: 'codex_agent_message', batchId: 'b1', taskIndex: 0 });
    bus.emit({ event: 'codex_turn_started', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([
      { method: 'markEvent', arg: 'text' },
      { method: 'markEvent', arg: 'llm' },
      { method: 'markEvent', arg: 'text' },
      { method: 'markEvent', arg: 'llm' },
    ]);
    stop();
  });

  it('ignores events from other tasks (batchId / taskIndex filter)', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'claude_tool_call', tool: 'Read', batchId: 'b2', taskIndex: 0 });
    bus.emit({ event: 'claude_tool_call', tool: 'Read', batchId: 'b1', taskIndex: 1 });

    expect(tracker.calls).toEqual([]);
    stop();
  });

  it('disposer removes the listener so post-stop events are ignored', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });
    stop();
    bus.emit({ event: 'claude_tool_call', tool: 'Read', batchId: 'b1', taskIndex: 0 });
    expect(tracker.calls).toEqual([]);
  });

  it('unknown events are ignored silently', () => {
    const tracker = makeStubTracker();
    const stop = startProgressEventsSubscriber({
      bus,
      tracker: tracker as unknown as Parameters<typeof startProgressEventsSubscriber>[0]['tracker'],
      batchId: 'b1',
      taskIndex: 0,
    });

    bus.emit({ event: 'some_unrelated_event', batchId: 'b1', taskIndex: 0 });
    bus.emit({ event: '', batchId: 'b1', taskIndex: 0 });

    expect(tracker.calls).toEqual([]);
    stop();
  });
});
