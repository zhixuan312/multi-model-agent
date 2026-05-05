import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerboseLogChannel } from '../../packages/core/src/events/verbose-log-channel.js';

describe('VerboseLogChannel', () => {
  it('appends JSONL to file and stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlog-'));
    const path = join(dir, 'log.jsonl');
    const captured: string[] = [];
    const fakeStdout: { write: (s: string) => boolean } = {
      write: (s: string) => { captured.push(s); return true; },
    };
    try {
      const c = new VerboseLogChannel(path, fakeStdout);
      c.emit({ type: 'test', taskIndex: 0 });
      c.emit({ type: 'test2', taskIndex: 1 });
      const fileContents = readFileSync(path, 'utf8');
      expect(fileContents.split('\n').filter(Boolean)).toHaveLength(2);
      expect(captured).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('writes to stdout even when file path is invalid', () => {
    const captured: string[] = [];
    const fakeStdout: { write: (s: string) => boolean } = {
      write: (s: string) => { captured.push(s); return true; },
    };
    const c = new VerboseLogChannel('/nonexistent/dir/log.jsonl', fakeStdout);
    // should not throw
    c.emit({ type: 'test' });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.type).toBe('test');
    expect(parsed.atMs).toBeTypeOf('number');
  });

  it('handles JSON.stringify failures gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlog-'));
    const path = join(dir, 'log.jsonl');
    const captured: string[] = [];
    const fakeStdout: { write: (s: string) => boolean } = {
      write: (s: string) => { captured.push(s); return true; },
    };
    try {
      const c = new VerboseLogChannel(path, fakeStdout);
      const circular: Record<string, unknown> = { type: 'circular' };
      (circular as any).self = circular;
      c.emit(circular);
      expect(captured).toHaveLength(1);
      const parsed = JSON.parse(captured[0].trim());
      expect(parsed._serializeError).toBe('VerboseLogChannel.stringify');
      expect(parsed.atMs).toBeTypeOf('number');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('handles stdout.write returning false (backpressure)', () => {
    const captured: string[] = [];
    const fakeStdout: { write: (s: string) => boolean } = {
      write: (s: string) => { captured.push(s); return false; },
    };
    const c = new VerboseLogChannel('/dev/null', fakeStdout);
    c.emit({ type: 'test' });
    expect(captured).toHaveLength(1);
  });
});
