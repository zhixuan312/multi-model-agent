import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve as resolvePath } from 'node:path';

// Mock node:child_process so we can drive the spawn outcome deterministically
// and assert how many attempts resolveGitToplevel makes. vi.mock is hoisted, so
// the spawn fn must come from vi.hoisted (a hoisted factory can't close over an
// ordinary module-scope local).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { resolveGitToplevel } =
  await import('../../packages/core/src/lifecycle/git-toplevel.js');

type Behavior =
  | { kind: 'success'; path: string }
  | { kind: 'error'; code: string }
  | { kind: 'exit'; code: number }
  | { kind: 'hang' };

// A minimal child stand-in: emits its scripted outcome on a microtask, after
// resolveGitToplevel has synchronously attached its data/error/exit listeners.
function fakeChild(behavior: Behavior) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // Defensive no-op 'error' listener: an EventEmitter 'error' with zero listeners
  // re-throws as an uncaught exception. The implementation attaches its own
  // 'error' handler too — both fire; this just guarantees emit() never throws if
  // a stale emission races the impl's listener lifecycle across tests.
  child.on('error', () => {});
  // setImmediate (a macrotask) lets the impl attach its listeners synchronously first.
  setImmediate(() => {
    if (behavior.kind === 'success') {
      child.stdout.emit('data', Buffer.from(behavior.path + '\n'));
      child.emit('exit', 0);
    } else if (behavior.kind === 'error') {
      const e = new Error('spawn failed') as NodeJS.ErrnoException;
      e.code = behavior.code;
      child.emit('error', e);
    } else if (behavior.kind === 'exit') {
      child.emit('exit', behavior.code);
    }
    // 'hang': emit nothing — the implementation's timeout fires.
  });
  return child;
}

beforeEach(() => spawnMock.mockReset());

describe('resolveGitToplevel — transient retry classification', () => {
  it('retries an EAGAIN fork failure, then returns the toplevel on success', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ kind: 'error', code: 'EAGAIN' }))
      .mockImplementationOnce(() => fakeChild({ kind: 'success', path: '/repo/root' }));
    const result = await resolveGitToplevel('/repo/root/sub');
    expect(result).toBe(resolvePath('/repo/root'));
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts consecutive EAGAIN failures (definitive null)', async () => {
    spawnMock.mockImplementation(() => fakeChild({ kind: 'error', code: 'EAGAIN' }));
    const result = await resolveGitToplevel('/busy', { maxAttempts: 3 });
    expect(result).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry ENOENT (git not installed) — single spawn, fast null', async () => {
    spawnMock.mockImplementation(() => fakeChild({ kind: 'error', code: 'ENOENT' }));
    const result = await resolveGitToplevel('/anywhere');
    expect(result).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a clean non-zero exit (not a repo) — single spawn', async () => {
    spawnMock.mockImplementation(() => fakeChild({ kind: 'exit', code: 128 }));
    const result = await resolveGitToplevel('/not/a/repo');
    expect(result).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout as definitive (no retry) and returns null', async () => {
    spawnMock.mockImplementation(() => fakeChild({ kind: 'hang' }));
    const result = await resolveGitToplevel('/slow', { timeoutMs: 10 });
    expect(result).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('coerces a non-finite maxAttempts to the default and still attempts once', async () => {
    spawnMock.mockImplementation(() => fakeChild({ kind: 'exit', code: 128 }));
    const result = await resolveGitToplevel('/x', { maxAttempts: Number.NaN });
    expect(result).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
