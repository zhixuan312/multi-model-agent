import { describe, it, expect } from 'vitest';
import { existsSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { startTestServer } from '../fixtures/start-test-server.js';

describe('harness writes no events to user global mmagent log', () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const userLog = join(homedir(), '.multi-model', 'logs', `mmagent-${todayUtc}.jsonl`);

  it('does not append to user-global jsonl during a test-server lifecycle', async () => {
    const sizeBefore = existsSync(userLog) ? statSync(userLog).size : 0;
    const cwd = mkdtempSync(join(tmpdir(), 'harness-iso-'));
    const server = await startTestServer({ cwd });
    await server.close();
    const sizeAfter = existsSync(userLog) ? statSync(userLog).size : 0;
    expect(sizeAfter).toBe(sizeBefore);
  });
});
