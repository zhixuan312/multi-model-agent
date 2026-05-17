import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogWriter } from '../../packages/core/src/events/log-writer.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';

describe('LogWriter', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });

  it('writes plain entry as one JSON line to stderr when diagnosticsLog=false', () => {
    const w = new LogWriter({ diagnosticsLog: false });
    w.receive({ type: 'plain', entry: { ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: { batch_id: 'b1' } } });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({ ts: '2026-05-17T00:00:00Z', kind: 'batch_created', fields: { batch_id: 'b1' } });
  });

  it('writes envelope snapshot with reason field', () => {
    const w = new LogWriter({ diagnosticsLog: false });
    const env = { taskId: 't', headline: {} } as never;
    w.receive({ type: 'envelope', envelope: env, reason: 'startStage' });
    const line = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.kind).toBe('envelope_snapshot');
    expect(parsed.reason).toBe('startStage');
    expect(parsed.envelope).toEqual(env);
  });

  it('runs secret redaction on output', () => {
    const w = new LogWriter({ diagnosticsLog: false });
    w.receive({ type: 'plain', entry: { ts: '2026-05-17T00:00:00Z', kind: 'server_started', fields: { token: 'sk-ant-abc123def456ghi789jkl' } } });
    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line).not.toContain('sk-ant-abc123def456ghi789jkl');
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

  it('spills oversized request body with 0600 mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-spill-'));
    const w = new LogWriter({ diagnosticsLog: true, logDir: dir });
    const { path, bytes } = await w.spillRequestBody({ batchId: '00000000-0000-0000-0000-000000000001', body: { hello: 'world' } });
    expect(bytes).toBeGreaterThan(0);
    const stat = statSync(path);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });
});
