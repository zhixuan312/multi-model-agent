import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLogSink } from '../../packages/core/src/observability/local-log-sink.js';
import { JsonlWriter } from '../../packages/core/src/diagnostics/jsonl-writer.js';

describe('LocalLogSink', () => {
  it('writes JSONL line per event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lls-'));
    const writer = new JsonlWriter({ dir });
    const sink = new LocalLogSink(writer);
    sink.emit({ event: 'task_started', ts: '2026-04-27T00:00:00Z', batchId: 'b', taskIndex: 0, route: 'delegate', cwd: '/' } as any);
    const file = readFileSync(join(dir, 'mmagent-2026-04-27.jsonl'), 'utf8');
    expect(file).toMatch(/"event":"task_started"/);
    rmSync(dir, { recursive: true });
  });
});
