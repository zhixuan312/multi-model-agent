import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerboseLogChannel } from '../../packages/core/src/channels/verbose-log-channel.js';

describe('VerboseLogChannel', () => {
  it('appends JSONL to file and stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlog-'));
    const path = join(dir, 'log.jsonl');
    const captured: string[] = [];
    const fakeStdout: any = { write: (s: string) => { captured.push(s); return true; } };
    const c = new VerboseLogChannel(path, fakeStdout);
    c.emit({ type: 'test', taskIndex: 0 });
    c.emit({ type: 'test2', taskIndex: 1 });
    const fileContents = readFileSync(path, 'utf8');
    expect(fileContents.split('\n').filter(Boolean)).toHaveLength(2);
    expect(captured).toHaveLength(2);
  });
});
