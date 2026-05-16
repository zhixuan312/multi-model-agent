import { describe, it, expect } from 'vitest';
import { VerboseLogChannel, formatVerboseLine } from '../../packages/core/src/events/verbose-log-channel.js';

// VerboseLogChannel is a stdout-only sink in 4.0.3+. The JSONL file is owned
// by LocalLogSink (gated on diagnostics.log). Verbose is gated on
// diagnostics.verbose and emits human-readable `[mmagent verbose]` lines
// matching the format used by request-observability breadcrumbs.

describe('VerboseLogChannel', () => {
  it('emits a single [mmagent verbose] line per event', () => {
    const captured: string[] = [];
    const fakeStdout = { write: (s: string) => { captured.push(s); return true; } };
    const c = new VerboseLogChannel(fakeStdout);

    c.emit({ event: 'task_started', ts: '2026-05-07T13:00:00.000Z', batchId: 'b1', route: 'audit' });
    c.emit({ event: 'task_completed', ts: '2026-05-07T13:00:01.000Z', batchId: 'b1' });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatch(/^\[mmagent verbose\] event=task_started ts=\S+ /);
    expect(captured[1]).toMatch(/^\[mmagent verbose\] event=task_completed /);
  });

  it('snake-cases camelCase fields and inlines nested objects as JSON', () => {
    const line = formatVerboseLine({
      event: 'runner_response_received',
      ts: '2026-05-07T13:00:00.000Z',
      batchId: 'b1',
      assistantTextLen: 0,
      contentBlocks: { text: 0, thinking: 1 },
    });
    expect(line).toContain('event=runner_response_received');
    expect(line).toContain('batch_id=b1');
    expect(line).toContain('assistant_text_len=0');
    expect(line).toContain('content_blocks={"text":0,"thinking":1}');
  });

  it('quotes string values containing whitespace or quotes', () => {
    const line = formatVerboseLine({
      event: 'runner_turn_completed',
      ts: '2026-05-07T13:00:00.000Z',
      message: 'with spaces and "quotes"',
    });
    expect(line).toContain('message="with spaces and \\"quotes\\""');
  });

  it('skips null and undefined fields', () => {
    const line = formatVerboseLine({
      event: 'x',
      ts: '2026-05-07T13:00:00.000Z',
      omittedNull: null,
      omittedUndef: undefined,
      kept: 1,
    });
    expect(line).not.toContain('omitted');
    expect(line).toContain('kept=1');
  });

  it('survives stdout.write throwing', () => {
    const fakeStdout = { write: (_: string) => { throw new Error('boom'); } };
    const c = new VerboseLogChannel(fakeStdout);
    expect(() => c.emit({ event: 'x', ts: '2026-05-07T13:00:00.000Z' })).not.toThrow();
  });

  it('defaults to process.stderr (not stdout)', () => {
    const stderrCalls: string[] = [];
    const stdoutCalls: string[] = [];
    const originalStderr = process.stderr.write.bind(process.stderr);
    const originalStdout = process.stdout.write.bind(process.stdout);
    (process.stderr.write as any) = (s: string) => { stderrCalls.push(s); return true; };
    (process.stdout.write as any) = (s: string) => { stdoutCalls.push(s); return true; };
    try {
      const channel = new VerboseLogChannel();
      channel.emit({ event: 'task_started', ts: '2026-05-16T00:00:00Z' });
    } finally {
      (process.stderr.write as any) = originalStderr;
      (process.stdout.write as any) = originalStdout;
    }
    expect(stderrCalls.join('')).toMatch(/^\[mmagent verbose\] event=task_started /);
    expect(stdoutCalls.join('')).toBe('');
  });
});
