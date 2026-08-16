/**
 * The ALWAYS-ON log must redact at least as much as the opt-in one.
 *
 * `redactSecrets` was wired into `log-writer.ts` only — the JSONL sink, which is off unless
 * `diagnostics.log` is set. `StderrLogSubscriber` is on for every `mma serve` with no quiet mode
 * and no flag, so the stream an operator actually watches, scrolls back through, captures in CI
 * and pastes into a bug report was the UNREDACTED one, while the opt-in file copy of the same
 * event was clean. That is backwards: the casually-shared stream is the one that needed it most.
 *
 * Provider events are what make it concrete. `codex_command_started` carries a whole command line,
 * `codex_error` a message, `claude_tool_call` a serialized tool input — a token in any of them
 * printed verbatim.
 */
import { describe, expect, it } from 'vitest';
import { formatStderrLine, StderrLogSubscriber } from '../../packages/core/src/events/stderr-log-subscriber.js';
import type { PlainLogEntry } from '../../packages/core/src/events/plain-log-entry.js';

const SECRETS: Array<[string, string]> = [
  ['anthropic key', 'sk-ant-api03-abcdefghijklmnop0123456789'],
  ['openai key', 'sk-abcdef0123456789ABCDEF0123'],
  ['aws key', 'AKIAIOSFODNN7EXAMPLE'],
  ['github pat', 'ghp_ABCDEFghijkl0123456789ABCDEFghijkl01'],
  ['gitlab pat', 'glpat-ABCDEFghijkl0123456789'],
];

function entryCarrying(secret: string): PlainLogEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'provider_event',
    fields: {
      provider: 'codex',
      event: 'codex_command_started',
      command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
    },
  } as PlainLogEntry;
}

describe('stderr log redaction', () => {
  it.each(SECRETS)('never prints a raw %s', (_label, secret) => {
    const line = formatStderrLine(entryCarrying(secret));
    expect(line, `secret reached stderr verbatim: ${line}`).not.toContain(secret);
    expect(line).toContain('[REDACTED');
  });

  it('redacts through the subscriber, not only the formatter', () => {
    const written: string[] = [];
    const subscriber = new StderrLogSubscriber((line) => { written.push(line); });
    subscriber.receive({ type: 'plain', entry: entryCarrying('sk-ant-api03-abcdefghijklmnop0123456789') });

    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('sk-ant-api03');
  });

  it('leaves everything that is not a secret intact', () => {
    const line = formatStderrLine({
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'batch_completed',
      fields: { task_id: 'abc-123', tool: 'investigate', duration_ms: 17 },
    } as PlainLogEntry);

    expect(line).toContain('event=batch_completed');
    expect(line).toContain('task_id=abc-123');
    expect(line).toContain('tool=investigate');
    expect(line).toContain('duration_ms=17');
    expect(line).not.toContain('[REDACTED');
  });
});
