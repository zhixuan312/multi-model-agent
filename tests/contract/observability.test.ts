/**
 * The observability contract, asserted against what the daemon ACTUALLY writes.
 *
 * This file used to construct `PlainLogEntry` literals in the test body, emit them through
 * `EnvelopeBus`, and then assert that the entries it had just typed matched the schema it had
 * typed them against. The bus is a pass-through, so nothing between the literal and the assertion
 * could change the value: every case was an assertion over its own input. Weakening the schema
 * would not have failed them, and neither would breaking every real emitter in the engine. The
 * envelope case had the same shape one layer up — it built a `TaskEnvelope` with the test-only
 * `TaskEnvelopeStore` fixture and checked the fixture's own output, while production assembles
 * envelopes in `buildEnvelopeSnapshot`.
 *
 * The harness has always had the seam for doing this properly — `boot({ diagnosticsLog: true })`,
 * whose docstring even says "the observability fixture sets this to true so it can read emitted
 * events back from disk". Nothing set it, because `LogWriter` falls back to the user's real
 * `~/.mma/logs` when no `logDir` is configured and the harness configured none. It now always
 * points at a fresh temp directory and exposes it as `handle.logDir`.
 *
 * So: run a real task through the real server, then read every line the daemon wrote and hold it
 * to the published schemas.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlainLogEntrySchema, PlainLogKindEnum } from '../../packages/core/src/events/plain-log-entry.js';
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

interface LoggedLine {
  kind: string;
  fields?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
  ts?: string;
  reason?: string;
}

/** Every JSONL record the daemon wrote to its diagnostics directory, in order. */
function readDiagnostics(logDir: string): LoggedLine[] {
  return readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(logDir, name), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedLine);
}

async function runOneTaskAndCollect(): Promise<LoggedLine[]> {
  const harness = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd(), diagnosticsLog: true });
  try {
    const submit = await fetch(`${harness.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${harness.token}`, 'X-MMA-Client': 'claude-code' },
      body: JSON.stringify({ type: 'investigate', prompt: 'observability contract' }),
    });
    const { executionId } = await submit.json() as { executionId: string };

    // Poll to terminal so the seal-time envelope is emitted before we read the log.
    for (let attempt = 0; attempt < 100; attempt++) {
      const poll = await fetch(`${harness.baseUrl}/execution/${executionId}`, {
        headers: { Authorization: `Bearer ${harness.token}`, 'X-MMA-Client': 'claude-code' },
      });
      if (poll.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The JSONL writer appends without fsync; give the OS a moment to flush.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return readDiagnostics(harness.logDir);
  } finally {
    await harness.close();
  }
}

describe('observability contract — what the daemon emits', () => {
  it('writes plain entries and an envelope snapshot for a real execution', async () => {
    const lines = await runOneTaskAndCollect();
    expect(lines.length, 'the daemon wrote nothing to its diagnostics log').toBeGreaterThan(0);

    const plain = lines.filter((line) => line.kind !== 'envelope_snapshot');
    const envelopes = lines.filter((line) => line.kind === 'envelope_snapshot');
    expect(plain.length, 'no plain log entries emitted').toBeGreaterThan(0);
    expect(envelopes.length, 'no envelope snapshot emitted').toBeGreaterThan(0);
  });

  it('every plain entry the engine emitted validates against PlainLogEntrySchema', async () => {
    const lines = await runOneTaskAndCollect();
    const plain = lines.filter((line) => line.kind !== 'envelope_snapshot');

    for (const entry of plain) {
      // `LogWriter` writes `{ ts, kind, fields }` — the entry shape, flattened one level.
      const result = PlainLogEntrySchema.safeParse({ ts: entry.ts, kind: entry.kind, fields: entry.fields ?? {} });
      expect(result.success, `emitted entry failed validation: ${JSON.stringify(entry)} — ${result.error?.message}`).toBe(true);
    }
  });

  it('every emitted kind is one the enum declares', async () => {
    const lines = await runOneTaskAndCollect();
    const emitted = new Set(lines.filter((line) => line.kind !== 'envelope_snapshot').map((line) => line.kind));

    expect(emitted.size).toBeGreaterThan(0);
    for (const kind of emitted) {
      expect(PlainLogKindEnum.options as readonly string[], `engine emitted an undeclared kind: ${kind}`).toContain(kind);
    }
  });

  it('the envelope snapshot carries the fields the wire record is built from', async () => {
    const lines = await runOneTaskAndCollect();
    const envelope = lines.find((line) => line.kind === 'envelope_snapshot')!.envelope!;

    // Only the fields `to-wire-record.ts` actually reads — asserting the whole shape here would
    // duplicate `envelope-shape-guard.test.ts`, which pins the key set at compile time.
    expect(typeof envelope['taskId']).toBe('string');
    expect(['delegate', 'audit', 'review', 'debug', 'investigate', 'execute-plan', 'research', 'journal-record', 'journal-recall', 'orchestrate', 'spec', 'plan']).toContain(envelope['route']);
    expect(['standard', 'complex', 'main']).toContain(envelope['agentType']);
    expect(['running', 'done', 'done_with_concerns', 'failed']).toContain(envelope['status']);
    expect(Array.isArray(envelope['stages'])).toBe(true);
    expect(Array.isArray(envelope['toolCalls'])).toBe(true);
    expect(Array.isArray(envelope['realFilesChanged'])).toBe(true);
    expect(typeof envelope['totalCostUSD']).toBe('number');
    expect(typeof envelope['totalDurationMs']).toBe('number');
  });
});
