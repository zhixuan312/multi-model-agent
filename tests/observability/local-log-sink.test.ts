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
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    sink.emit({ event: 'task_started', ts: now.toISOString(), batchId: 'b', taskIndex: 0, route: 'delegate', cwd: '/' } as any);
    const file = readFileSync(join(dir, `mmagent-${today}.jsonl`), 'utf8');
    expect(file).toMatch(/"event":"task_started"/);
    rmSync(dir, { recursive: true });
  });
});
