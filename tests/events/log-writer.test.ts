import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogWriter } from '../../packages/core/src/events/log-writer.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';

describe('LogWriter — JSONL disabled (4.7.3+ contract)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });

  it('is a no-op on receive() when diagnosticsLog=false (stderr is owned by StderrLogSubscriber)', () => {
    const w = new LogWriter({ diagnosticsLog: false });
    w.receive({ type: 'plain', entry: { ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: { batch_id: 'b1' } } });
    w.receive({ type: 'envelope', envelope: { taskId: 't', headline: {} } as never, reason: 'startStage' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('LogWriter — JSONL enabled', () => {
  it('runs secret redaction before writing to file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-log-redact-'));
    const w = new LogWriter({ diagnosticsLog: true, logDir: dir });
    w.receive({ type: 'plain', entry: { ts: '2026-05-17T00:00:00Z', kind: 'server_started', fields: { token: 'sk-ant-abc123def456ghi789jkl' } } });
    await new Promise(r => setTimeout(r, 50));
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const contents = readFileSync(join(dir, files[0]), 'utf8');
    expect(contents).not.toContain('sk-ant-abc123def456ghi789jkl');
  });
});

describe('LogWriter file destination', () => {
  it('writes to JSONL file when diagnosticsLog=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-log-'));
    const w = new LogWriter({ diagnosticsLog: true, logDir: dir });
    w.receive({ type: 'plain', entry: { ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: { batch_id: 'b1' } } });
    await new Promise(r => setTimeout(r, 50));
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const contents = readFileSync(join(dir, files[0]), 'utf8');
    expect(contents).toContain('"batch_id":"b1"');
  });

});
