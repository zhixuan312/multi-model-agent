import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServe } from '../../packages/server/src/cli/serve.js';

function minimalConfig(tokenFile: string) {
  return {
    agents: {
      standard: { type: 'codex' as const, model: 'm', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE' },
      complex: { type: 'codex' as const, model: 'm', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE' },
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile },
      limits: {
        projectCap: 10,
        batchTtlMs: 3_600_000,
        maxContextBlocksPerProject: 100,
        shutdownDrainMs: 1_000,
        maxBodyBytes: 10_000_000,
        maxContextBlockBytes: 1_000_000,
      },
      autoUpdateSkills: false,
    },
    diagnostics: { log: false },
  };
}

class FakeExit extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

function fakeExit(code: number): never {
  throw new FakeExit(code);
}

function emitExitSafe(emitter: NodeJS.EventEmitter, event: string, ...args: unknown[]): void {
  try {
    emitter.emit(event, ...args);
  } catch (e: unknown) {
    if (!(e instanceof FakeExit)) throw e;
  }
}

function processEmitSafe(event: string, ...args: unknown[]): void {
  try {
    process.emit(event, ...args);
  } catch (e: unknown) {
    if (!(e instanceof FakeExit)) throw e;
  }
}

describe('serve crash-guard (Bug 7)', () => {
  let dir: string;
  let tokenFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'serve-crash-'));
    tokenFile = join(dir, 'auth-token');
    writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
    process.env.MMA_TELEMETRY_ENDPOINT = '';
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.MMA_TELEMETRY_ENDPOINT;
  });

  it('stdout/stderr EPIPE triggers clean exit, not Node abort', async () => {
    const stderrErrBefore = process.stderr.listenerCount('error');
    const stdoutErrBefore = process.stdout.listenerCount('error');

    const exitCalls: number[] = [];
    const handle = await startServe(minimalConfig(tokenFile) as any, (code) => {
      exitCalls.push(code);
      throw new FakeExit(code);
    });

    // Confirm Edit I attached listeners to BOTH stdio streams.
    expect(process.stderr.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(process.stdout.listenerCount('error')).toBeGreaterThanOrEqual(1);

    // Synthesize the exact event Node emits when the parent pipe closes.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
    emitExitSafe(process.stderr, 'error', epipe);
    expect(exitCalls).toEqual([0]);  // EPIPE → exit(0), not exit(1)

    // Same for stdout — different listener, same outcome.
    exitCalls.length = 0;
    emitExitSafe(process.stdout, 'error', epipe);
    expect(exitCalls).toEqual([0]);

    // Non-EPIPE error on stderr → exit(1).
    exitCalls.length = 0;
    const other = Object.assign(new Error('EBADF'), { code: 'EBADF' });
    emitExitSafe(process.stderr, 'error', other);
    expect(exitCalls).toEqual([1]);

    // Listeners are removed when stop() is called — verify count returns to baseline.
    await handle.stop();
    expect(process.stderr.listenerCount('error')).toBe(stderrErrBefore);
    expect(process.stdout.listenerCount('error')).toBe(stdoutErrBefore);
  });

  it('uncaughtException and unhandledRejection route through Edit I handlers', async () => {
    const uncaughtBefore = process.listenerCount('uncaughtException');
    const unhandledBefore = process.listenerCount('unhandledRejection');

    const exitCalls: number[] = [];
    const handle = await startServe(minimalConfig(tokenFile) as any, (code) => {
      exitCalls.push(code);
      throw new FakeExit(code);
    });

    expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(uncaughtBefore + 1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(unhandledBefore + 1);

    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    processEmitSafe('uncaughtException', epipe);
    expect(exitCalls).toEqual([0]);

    exitCalls.length = 0;
    processEmitSafe('uncaughtException', new Error('boom'));
    expect(exitCalls).toEqual([1]);

    exitCalls.length = 0;
    processEmitSafe('unhandledRejection', epipe, Promise.resolve());
    expect(exitCalls).toEqual([0]);

    exitCalls.length = 0;
    processEmitSafe('unhandledRejection', new Error('reject-boom'), Promise.resolve());
    expect(exitCalls).toEqual([1]);

    await handle.stop();
    expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore);
    expect(process.listenerCount('unhandledRejection')).toBe(unhandledBefore);
  });
});
