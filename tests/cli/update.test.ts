/**
 * `mma update`.
 *
 * Two things carry the whole design and are tested hardest:
 *
 *   1. Detection that is UNSURE must stop. Guessing a package manager installs
 *      to somewhere the user's shell does not resolve, and then reports success
 *      while the old binary still runs — the exact class of silent failure this
 *      command replaces.
 *   2. The phases after the install must run the NEW code, which is why the
 *      command re-executes itself. Skill sync happens in-process, so an update
 *      that stayed put would write skill files from the OLD bundle and report
 *      them refreshed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, runUpdate, UpdateExitCode } from '../../packages/server/src/cli/update.js';

let home: string;
let stateDir: string;

function statusFetch(body: unknown | null): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    if (u.endsWith('/status') && body !== null) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 500 });
  }) as unknown as typeof fetch;
}

const base = () => ({
  stateDir,
  homeDir: home,
  serverUrl: 'http://127.0.0.1:9',
  token: 't',
  cliPath: '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/cli/index.js',
  logPath: join(home, '.mma', 'serve.log'),
  cliVersion: '6.4.0',
  platform: 'linux' as NodeJS.Platform,
  sleep: async () => {},
  isAlive: () => false,
  lookupPortOwner: () => null,
  verifyProcess: () => true,
  syncSkills: async () => 0,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mma-update-home-'));
  stateDir = mkdtempSync(join(tmpdir(), 'mma-update-state-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('detectPackageManager', () => {
  it('infers npm from a node_modules install path', () => {
    const d = detectPackageManager({
      modulePath: '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/cli/update.js',
      hasCommand: () => true,
    });
    expect(d).toMatchObject({ manager: 'npm', certain: true });
    expect(d.command).toEqual(['npm', 'install', '-g', '@zhixuan92/multi-model-agent@latest']);
  });

  it('infers pnpm from a pnpm global store path', () => {
    const d = detectPackageManager({
      modulePath: '/Users/x/Library/pnpm/global/5/.pnpm/@zhixuan92+multi-model-agent/dist/cli/update.js',
      hasCommand: () => true,
    });
    expect(d).toMatchObject({ manager: 'pnpm', certain: true });
    expect(d.command[0]).toBe('pnpm');
  });

  it('infers bun from a bun global install path', () => {
    const d = detectPackageManager({
      modulePath: '/Users/x/.bun/install/global/node_modules/@zhixuan92/multi-model-agent/dist/cli/update.js',
      hasCommand: () => true,
    });
    expect(d).toMatchObject({ manager: 'bun', certain: true });
    expect(d.command[0]).toBe('bun');
  });

  // Running from a source checkout. Installing would not replace what is
  // actually running, so the command must not proceed.
  it('is not certain when the path looks like nothing it recognises', () => {
    const d = detectPackageManager({
      modulePath: '/Users/x/code/multi-model-agent/packages/server/src/cli/update.ts',
      hasCommand: () => true,
    });
    expect(d.certain).toBe(false);
    expect(d.manager).toBeNull();
    expect(d.reason).toContain('cannot tell');
  });

  it('is not certain when the inferred manager is not on PATH', () => {
    const d = detectPackageManager({
      modulePath: '/Users/x/Library/pnpm/global/5/node_modules/@zhixuan92/multi-model-agent/dist/cli/update.js',
      hasCommand: () => false,
    });
    expect(d.certain).toBe(false);
    expect(d.reason).toContain('not on PATH');
    // Still reports the command, so the user can run it themselves.
    expect(d.command[0]).toBe('pnpm');
  });

  it('honours an explicit override', () => {
    const d = detectPackageManager({ override: 'bun', hasCommand: () => true });
    expect(d).toMatchObject({ manager: 'bun', certain: true });
  });
});

describe('install phase', () => {
  it('stops and prints the exact command when detection is not certain', async () => {
    const err: string[] = [];
    const installs: string[][] = [];
    const code = await runUpdate({
      ...base(),
      fetch: statusFetch(null),
      detect: () => ({ manager: null, certain: false, command: ['npm', 'install', '-g', 'pkg@latest'], reason: 'cannot tell' }),
      runInstall: (c) => { installs.push(c); return { ok: true, output: '' }; },
      reexec: () => 0,
      stdout: () => true,
      stderr: (s) => { err.push(s); return true; },
    });
    expect(code).toBe(UpdateExitCode.ERR_MANAGER_UNKNOWN);
    // Nothing was installed, and nothing else was touched.
    expect(installs).toEqual([]);
    expect(err.join('')).toContain('npm install -g pkg@latest');
    expect(err.join('')).toContain('--no-install');
  });

  it('does not re-execute when the install fails', async () => {
    let reexeced = false;
    const code = await runUpdate({
      ...base(),
      fetch: statusFetch(null),
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      runInstall: () => ({ ok: false, output: 'EACCES' }),
      reexec: () => { reexeced = true; return 0; },
      stdout: () => true,
      stderr: () => true,
    });
    expect(code).toBe(UpdateExitCode.ERR_INSTALL);
    expect(reexeced).toBe(false);
  });

  it('skips the install but still re-executes with --no-install', async () => {
    const installs: string[][] = [];
    let argv: string[] = [];
    await runUpdate({
      ...base(), noInstall: true,
      fetch: statusFetch(null),
      runInstall: (c) => { installs.push(c); return { ok: true, output: '' }; },
      reexec: (a) => { argv = a; return 0; },
      stdout: () => true, stderr: () => true,
    });
    expect(installs).toEqual([]);
    expect(argv).toContain('--post-install');
  });

  // The reason the command re-executes at all.
  it('re-executes the new binary, passing the pre-install version through', async () => {
    let argv: string[] = [];
    await runUpdate({
      ...base(),
      fetch: statusFetch(null),
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      runInstall: () => ({ ok: true, output: '' }),
      reexec: (a) => { argv = a; return 0; },
      stdout: () => true, stderr: () => true,
    });
    expect(argv[0]).toBe(base().cliPath);
    expect(argv).toContain('update');
    expect(argv).toContain('--post-install');
    expect(argv).toContain('--previous-version=6.4.0');
  });

  // Found by running it for real. Without this the second half loads the
  // DEFAULT config, so `mma update --config /custom` restarts a different
  // daemon than the one phase 1 just inspected, and reports that as the update.
  it('carries --config through to the re-executed half', async () => {
    let argv: string[] = [];
    await runUpdate({
      ...base(), serveArgs: ['--config', '/etc/mma.json'],
      fetch: statusFetch(null),
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      runInstall: () => ({ ok: true, output: '' }),
      reexec: (a) => { argv = a; return 0; },
      stdout: () => true, stderr: () => true,
    });
    expect(argv.join(' ')).toContain('--config /etc/mma.json');
  });

  // The recursion guard. `--post-install` is what stops the child repeating
  // phase 1; if the second half ever installed again it would re-exec again,
  // and the command would loop installing forever.
  it('never installs in the post-install half, so the re-exec cannot recurse', async () => {
    let installs = 0;
    let reexecs = 0;
    await runUpdate({
      ...base(), postInstall: true, previousVersion: '6.3.0',
      fetch: statusFetch(null),
      runInstall: () => { installs++; return { ok: true, output: '' }; },
      reexec: () => { reexecs++; return 0; },
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      stdout: () => true, stderr: () => true,
    });
    expect(installs).toBe(0);
    expect(reexecs).toBe(0);
  });

  it('installs exactly once even when the re-executed half fails', async () => {
    let installs = 0;
    const code = await runUpdate({
      ...base(),
      fetch: statusFetch(null),
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      runInstall: () => { installs++; return { ok: true, output: '' }; },
      // What a missing entry point looks like through defaultReexec: spawnSync
      // returns a null status, which maps to a non-zero code.
      reexec: () => UpdateExitCode.ERR_INSTALL,
      stdout: () => true, stderr: () => true,
    });
    expect(installs).toBe(1);
    expect(code).not.toBe(UpdateExitCode.SUCCESS);
  });

  it('propagates the re-executed exit code rather than always reporting success', async () => {
    const code = await runUpdate({
      ...base(), noInstall: true,
      fetch: statusFetch(null),
      reexec: () => 3,
      stdout: () => true, stderr: () => true,
    });
    expect(code).toBe(3);
  });
});

describe('in-flight work', () => {
  // Confirmed product decision: proceed, but never silently. The warning has to
  // land BEFORE anything destructive happens.
  it('warns about running tasks before installing anything', async () => {
    const out: string[] = [];
    const order: string[] = [];
    await runUpdate({
      ...base(),
      fetch: statusFetch({ pid: 42, version: '6.3.0', counters: { activeTasks: 2 } }),
      isAlive: () => true, lookupPortOwner: () => 42,
      detect: () => ({ manager: 'npm', certain: true, command: ['npm', 'i'], reason: '' }),
      runInstall: () => { order.push('install'); return { ok: true, output: '' }; },
      reexec: () => 0,
      stdout: (s) => { out.push(s); if (s.includes('WARNING')) order.push('warn'); return true; },
      stderr: () => true,
    });
    expect(out.join('')).toContain('2 running task(s) will be interrupted');
    expect(order).toEqual(['warn', 'install']);
  });
});

describe('post-install phases', () => {
  it('leaves the daemon stopped when none was running, and says so', async () => {
    const out: string[] = [];
    let started = false;
    const code = await runUpdate({
      ...base(), postInstall: true, previousVersion: '6.3.0',
      fetch: statusFetch(null),
      startDaemon: () => { started = true; return 123; },
      stdout: (s) => { out.push(s); return true; },
      stderr: () => true,
    });
    expect(code).toBe(UpdateExitCode.SUCCESS);
    // Starting a daemon the user had not started is a change they did not ask for.
    expect(started).toBe(false);
    expect(out.join('')).toContain('was not running; left stopped');
  });

  it('restarts a running daemon and reports the version it now serves', async () => {
    const out: string[] = [];
    let alive = true;
    const code = await runUpdate({
      ...base(), postInstall: true, previousVersion: '6.3.0',
      fetch: statusFetch({ pid: 42, version: '6.4.0' }),
      isAlive: () => alive, lookupPortOwner: () => 42,
      kill: () => { alive = false; },
      startDaemon: () => 123,
      stdout: (s) => { out.push(s); return true; },
      stderr: () => true,
    });
    expect(code).toBe(UpdateExitCode.SUCCESS);
    expect(out.join('')).toContain('6.3.0 → 6.4.0 installed');
    expect(out.join('')).toContain('/status reports 6.4.0');
  });

  // This is the exact skew the command exists to remove. It must never pass silently.
  it('warns when the restarted daemon reports a different version from the package', async () => {
    const err: string[] = [];
    let alive = true;
    await runUpdate({
      ...base(), postInstall: true, previousVersion: '6.3.0',
      fetch: statusFetch({ pid: 42, version: '6.3.0' }),
      isAlive: () => alive, lookupPortOwner: () => 42,
      kill: () => { alive = false; },
      startDaemon: () => 123,
      stdout: () => true,
      stderr: (s) => { err.push(s); return true; },
    });
    expect(err.join('')).toContain('WARNING');
    expect(err.join('')).toContain('Another daemon may own the port');
  });

  it('fails without starting a replacement when the old daemon will not stop', async () => {
    let started = false;
    let clock = 0;
    const code = await runUpdate({
      ...base(), postInstall: true,
      fetch: statusFetch({ pid: 42, version: '6.3.0' }),
      isAlive: () => true, lookupPortOwner: () => 42,
      kill: () => {},
      now: () => (clock += 500),
      startDaemon: () => { started = true; return 1; },
      stdout: () => true, stderr: () => true,
    });
    expect(code).toBe(UpdateExitCode.ERR_DAEMON);
    // Starting anyway would just fail on the bound port and hide the real cause.
    expect(started).toBe(false);
  });

  it('names the applications to restart, and says when none need it', async () => {
    const out: string[] = [];
    await runUpdate({
      ...base(), postInstall: true,
      fetch: statusFetch(null),
      stdout: (s) => { out.push(s); return true; },
      stderr: () => true,
    });
    expect(out.join('')).toContain('No client applications need restarting');
  });
});
