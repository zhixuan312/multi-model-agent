import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emitRequestReceived } from '../../packages/server/src/http/request-observability.js';
import { buildTestAgentConfig } from '../helpers/test-server-with-agents.js';

describe('emitRequestReceived — always-on (A4, A8)', () => {
  let stderrCalls: string[] = [];
  let stdoutCalls: string[] = [];
  let consoleLogCalls: string[] = [];
  let originalStderr: typeof process.stderr.write;
  let originalStdout: typeof process.stdout.write;
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    stderrCalls = []; stdoutCalls = []; consoleLogCalls = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    originalStdout = process.stdout.write.bind(process.stdout);
    originalConsoleLog = console.log;
    (process.stderr.write as any) = (s: string) => { stderrCalls.push(s); return true; };
    (process.stdout.write as any) = (s: string) => { stdoutCalls.push(s); return true; };
    console.log = (...args: unknown[]) => { consoleLogCalls.push(args.map(String).join(' ')); };
  });
  afterEach(() => {
    (process.stderr.write as any) = originalStderr;
    (process.stdout.write as any) = originalStdout;
    console.log = originalConsoleLog;
  });

  it('emits batch_created and request_received to stderr when diagnostics.log is false', async () => {
    const config = buildTestAgentConfig({ diagnostics: { log: false } });
    await emitRequestReceived({ config, batchId: 'b-1', route: '/delegate', parsed: { hello: 'world' } });
    const joined = stderrCalls.join('');
    expect(joined).toMatch(/event=batch_created /);
    expect(joined).toMatch(/event=request_received /);
    expect(joined).toMatch(/batch=b-1/);
    expect(stdoutCalls.join('')).toBe('');
    expect(consoleLogCalls).toEqual([]);
  });
});
