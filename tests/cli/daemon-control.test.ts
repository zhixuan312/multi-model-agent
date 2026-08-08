/**
 * Finding and stopping the daemon.
 *
 * Two behaviours matter here, and both are the reasons this module replaced
 * `pkill -f "mma serve"`:
 *
 *   1. Identity is CONFIRMED, not inferred. A pidfile whose pid the operating
 *      system has since recycled must not be acted on.
 *   2. Stopping WAITS. Returning while the process is still alive is what made
 *      `pkill …; mma serve` lose the port race with its own predecessor.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePidfile, type DaemonRecord } from '../../packages/server/src/pidfile.js';
import {
  inheritableExecArgv,
  resolveDaemon,
  startDaemonDetached,
  stopDaemon,
  waitForHealth,
} from '../../packages/server/src/cli/daemon-control.js';

let dir: string;

const record: DaemonRecord = {
  pid: 4242, port: 9, bind: '127.0.0.1', version: '6.4.0',
  bootId: 'boot-abc', startedAt: 1_700_000_000_000,
};

/** A fetch that answers /status with `body`, and 500s everything else. */
function statusFetch(body: unknown | null): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/status') && body !== null) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/status')) return new Response('', { status: 500 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

const base = {
  // Port 9 (discard) — deliberately NOT 7337. An earlier version of this file
  // used the real default port, and when a stubbed pid failed verification the
  // fallback path reached the developer's own running daemon and asserted
  // against it. A unit test must never be able to touch a live daemon.
  serverUrl: 'http://127.0.0.1:9',
  token: 't',
  sleep: async () => {},
  platform: 'linux' as NodeJS.Platform,
  // Identity verification shells out to `ps`. Stubbed by default so tests
  // describe intent rather than whatever pids happen to exist on the machine;
  // the tests that care about refusal override it explicitly.
  verifyProcess: () => true,
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-dc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('resolveDaemon', () => {
  it('confirms identity when /status reports the pidfile pid', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir,
      fetch: statusFetch({ pid: 4242, version: '6.4.1', counters: { activeTasks: 3 } }),
      isAlive: () => true,
    });
    expect(found).toMatchObject({ pid: 4242, port: 9, source: 'pidfile', reachable: true, activeTasks: 3 });
    // The DAEMON's version wins over the record's: the record was written by
    // whichever build started it, and doctor must report what is serving.
    expect(found?.version).toBe('6.4.1');
  });

  it('still resolves when the daemon is alive but not answering', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir, fetch: statusFetch(null), isAlive: () => true,
    });
    // Draining or wedged — still ours to stop.
    expect(found).toMatchObject({ pid: 4242, reachable: false, source: 'pidfile' });
    expect(found?.version).toBe('6.4.0');
  });

  // The reason the record carries more than a pid.
  it('ignores a stale record whose pid is dead and falls back to the port owner', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir,
      fetch: statusFetch(null),
      isAlive: () => false,          // the recorded pid is gone
      lookupPortOwner: () => 9999,   // something else owns the port
    });
    expect(found).toMatchObject({ pid: 9999, source: 'port-scan' });
  });

  it('does not resolve a daemon whose recorded pid is dead and whose port is free', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir, fetch: statusFetch(null),
      isAlive: () => false, lookupPortOwner: () => null,
    });
    expect(found).toBeNull();
  });

  // Daemons started by a release that predates pidfiles must still be findable,
  // or the first update after upgrading cannot stop anything.
  it('finds a daemon that never wrote a pidfile, via the port owner', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir,
      fetch: statusFetch({ pid: 555, version: '6.3.0' }),
      isAlive: () => true, lookupPortOwner: () => 555,
    });
    expect(found).toMatchObject({ pid: 555, port: 9, source: 'port-scan', reachable: true, version: '6.3.0' });
  });

  it('never shells out for a port owner on Windows', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir, platform: 'win32',
      fetch: statusFetch(null), isAlive: () => false,
    });
    expect(found).toBeNull();
  });

  // Windows has no port-owner lookup, so /status reporting its own pid is the
  // only evidence available there. It is also better evidence than lsof
  // everywhere else: the process itself is speaking.
  it('uses the pid /status reports when there is no pidfile and no port lookup', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir, platform: 'win32',
      fetch: statusFetch({ pid: 777, version: '6.4.0' }),
      isAlive: () => true,
    });
    expect(found).toMatchObject({ pid: 777, reachable: true, version: '6.4.0' });
  });

  it('prefers the pid /status reports over the port owner', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir,
      fetch: statusFetch({ pid: 777, version: '6.4.0' }),
      isAlive: () => true,
      lookupPortOwner: () => 888,
    });
    expect(found?.pid).toBe(777);
  });

  it('returns null when nothing is running at all', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir, fetch: statusFetch(null),
      isAlive: () => false, lookupPortOwner: () => null,
    });
    expect(found).toBeNull();
  });

  // ── identity verification ────────────────────────────────────────────
  // A pidfile survives a crash and the operating system reuses pids, so a live
  // process at the recorded pid may be something else entirely. Returning it
  // would make `mma stop` signal a program the user never asked to stop —
  // reintroducing the exact fault `pkill -f` had, one layer down.

  it('refuses a live pidfile pid that is not a daemon', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir, fetch: statusFetch(null),
      isAlive: () => true,
      verifyProcess: () => false,   // the pid was recycled
      lookupPortOwner: () => null,
    });
    expect(found).toBeNull();
  });

  it('refuses a port owner that never answered /status and is not a daemon', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir, fetch: statusFetch(null),
      isAlive: () => true,
      lookupPortOwner: () => 31337,  // some unrelated program took the port
      verifyProcess: () => false,
    });
    expect(found).toBeNull();
  });

  // A daemon that answered /status has already identified itself. Demanding a
  // command-line match as well would break any layout the pattern misses.
  it('accepts a port owner that DID answer /status even when the command line does not match', async () => {
    const found = await resolveDaemon({
      ...base, stateDir: dir,
      fetch: statusFetch({ pid: 555, version: '6.4.0' }),
      isAlive: () => true, lookupPortOwner: () => 555,
      verifyProcess: () => false,
    });
    expect(found?.pid).toBe(555);
  });

  // Windows has no cheap command-line probe, so verification returns null
  // there. Null must mean "cannot verify", not "verified false" — otherwise
  // stop and restart stop working on Windows entirely.
  it('treats unverifiable (Windows) as acceptable rather than as refusal', async () => {
    writePidfile(dir, record);
    const found = await resolveDaemon({
      ...base, stateDir: dir, platform: 'win32',
      fetch: statusFetch(null), isAlive: () => true,
      verifyProcess: () => null,
    });
    expect(found).toMatchObject({ pid: 4242, reachable: false });
  });
});

describe('stopDaemon', () => {
  it('reports success without signalling when the process is already gone', async () => {
    const signals: string[] = [];
    const out = await stopDaemon(1, {
      ...base, stateDir: dir, isAlive: () => false,
      kill: (_p, s) => { signals.push(s); },
    });
    expect(out).toMatchObject({ stopped: true, escalatedTo: 'none' });
    expect(signals).toEqual([]);
  });

  it('stops on the first SIGTERM when the daemon exits during its drain', async () => {
    const signals: string[] = [];
    let alive = true;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      isAlive: () => alive,
      kill: (_p, s) => { signals.push(s); alive = false; },
      graceMs: 1000,
    });
    expect(out).toMatchObject({ stopped: true, escalatedTo: 'SIGTERM' });
    expect(signals).toEqual(['SIGTERM']);
  });

  // The daemon's own contract: a SECOND signal means "stop draining, exit now".
  // The escalation follows that rather than jumping straight to SIGKILL.
  it('sends a second SIGTERM before resorting to SIGKILL', async () => {
    const signals: string[] = [];
    let alive = true;
    let clock = 0;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      now: () => (clock += 200),
      isAlive: () => alive,
      kill: (_p, s) => { signals.push(s); if (signals.length === 2) alive = false; },
      graceMs: 1000, killAfterMs: 1000,
    });
    expect(signals).toEqual(['SIGTERM', 'SIGTERM']);
    expect(out).toMatchObject({ stopped: true, escalatedTo: 'SIGTERM(second)' });
  });

  it('escalates to SIGKILL and reports that it had to', async () => {
    const signals: string[] = [];
    let alive = true;
    let clock = 0;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      now: () => (clock += 200),
      isAlive: () => alive,
      kill: (_p, s) => { signals.push(s); if (s === 'SIGKILL') alive = false; },
      graceMs: 1000, killAfterMs: 1000,
    });
    expect(signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
    expect(out).toMatchObject({ stopped: true, escalatedTo: 'SIGKILL' });
  });

  // A stop that reports success while the process still holds the port is the
  // whole failure this replaces; it must report failure instead.
  it('reports failure when the process survives SIGKILL', async () => {
    let clock = 0;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      now: () => (clock += 200),
      isAlive: () => true,
      kill: () => {},
      graceMs: 500, killAfterMs: 500,
    });
    expect(out.stopped).toBe(false);
  });

  // Between two signals the daemon can exit and its pid be handed to something
  // else. Escalating on the bare number would then SIGKILL an unrelated
  // process, so identity is re-confirmed before each escalation.
  it('stops escalating when the pid is no longer a daemon', async () => {
    const signals: string[] = [];
    let clock = 0;
    let isDaemon = true;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      now: () => (clock += 200),
      isAlive: () => true,                       // pid stays alive — but reused
      verifyProcess: () => isDaemon,
      kill: (_p, s) => { signals.push(s); isDaemon = false; },
      graceMs: 500, killAfterMs: 500,
    });
    // One SIGTERM only: after it, the pid no longer belongs to a daemon.
    expect(signals).toEqual(['SIGTERM']);
    expect(out.stopped).toBe(true);
  });

  it('does not fail when the process exits between the liveness check and the signal', async () => {
    let alive = true;
    const out = await stopDaemon(1, {
      ...base, stateDir: dir,
      isAlive: () => alive,
      kill: () => { alive = false; throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    });
    expect(out.stopped).toBe(true);
  });
});

// Found by running a real restart: the entry point is whatever this process was
// loaded from, and under a TypeScript runner bare `node` cannot execute it, so
// the spawned daemon died instantly. Starting the child the way the parent was
// started is correct in production AND in development.
describe('inheritableExecArgv', () => {
  it('forwards module-loader flags', () => {
    expect(inheritableExecArgv(['--require', '/x/preflight.cjs', '--import', 'file:///x/loader.mjs']))
      .toEqual(['--require', '/x/preflight.cjs', '--import', 'file:///x/loader.mjs']);
  });

  it('is empty for a plain production process', () => {
    expect(inheritableExecArgv([])).toEqual([]);
  });

  // A detached daemon inheriting --inspect fights the parent for the debugger
  // port; inheriting --eval runs a script instead of the CLI.
  it('drops debugger flags', () => {
    expect(inheritableExecArgv(['--require', '/x.cjs', '--inspect', '--inspect-brk=9229']))
      .toEqual(['--require', '/x.cjs']);
  });

  it('drops --eval and the script that follows it', () => {
    expect(inheritableExecArgv(['--import', '/l.mjs', '--eval', 'console.log(1)']))
      .toEqual(['--import', '/l.mjs']);
    expect(inheritableExecArgv(['--eval=console.log(1)', '--import', '/l.mjs']))
      .toEqual(['--import', '/l.mjs']);
  });
});

describe('startDaemonDetached', () => {
  it('puts the inherited flags before the entry point, and serve after it', () => {
    let seen: string[] = [];
    const pid = startDaemonDetached({
      cliPath: '/app/dist/cli/index.js',
      logPath: '/tmp/does-not-matter.log',
      args: ['--config', '/etc/mma.json'],
      execArgv: ['--import', '/l.mjs'],
      openLog: () => 1,
      spawn: ((_exec: string, argv: string[]) => {
        seen = argv;
        return { pid: 321, unref: () => {} };
      }) as unknown as typeof import('node:child_process').spawn,
    });
    expect(pid).toBe(321);
    expect(seen).toEqual(['--import', '/l.mjs', '/app/dist/cli/index.js', 'serve', '--config', '/etc/mma.json']);
  });

  it('reports null rather than throwing when the spawn fails', () => {
    const pid = startDaemonDetached({
      cliPath: '/app/dist/cli/index.js',
      logPath: '/tmp/x.log',
      openLog: () => { throw new Error('EACCES'); },
    });
    expect(pid).toBeNull();
  });
});

describe('waitForHealth', () => {
  it('returns true as soon as /health answers', async () => {
    let calls = 0;
    const ok = await waitForHealth('http://127.0.0.1:9', 5000, {
      sleep: async () => {},
      fetch: (async () => {
        calls++;
        return calls < 3 ? new Response('', { status: 503 }) : new Response('{"status":"ok"}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('returns false when the budget runs out', async () => {
    let clock = 0;
    const ok = await waitForHealth('http://127.0.0.1:9', 1000, {
      now: () => (clock += 300),
      sleep: async () => {},
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});
