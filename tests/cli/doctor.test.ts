/**
 * `mma doctor`.
 *
 * The report exists to catch partial updates, so the tests are mostly about
 * what counts as a PROBLEM. Two mistakes would each make it useless: flagging a
 * maintainer's unreleased build as drift trains the reader to ignore the
 * report, and treating an offline machine as broken makes it unusable on a
 * plane.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReport, compareVersions, runDoctor, DoctorExitCode } from '../../packages/server/src/cli/doctor.js';

let home: string;
let stateDir: string;

function statusFetch(body: unknown | null): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/status') && body !== null) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 500 });
  }) as unknown as typeof fetch;
}

function withPlugin(key: string, version: string): void {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [key]: true } }));
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [key]: [{ version, lastUpdated: '2026-08-01T00:00:00Z' }] } }),
  );
}

const base = () => ({
  stateDir,
  homeDir: home,
  serverUrl: 'http://127.0.0.1:9',
  token: 't',
  platform: 'linux' as NodeJS.Platform,
  sleep: async () => {},
  isAlive: () => true,
  lookupPortOwner: () => null,
  verifyProcess: () => true,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mma-doctor-home-'));
  stateDir = mkdtempSync(join(tmpdir(), 'mma-doctor-state-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('orders release versions numerically, not as strings', () => {
    expect(compareVersions('6.9.0', '6.10.0')).toBeLessThan(0);
    expect(compareVersions('6.4.0', '6.3.9')).toBeGreaterThan(0);
    expect(compareVersions('6.4.0', '6.4.0')).toBe(0);
  });

  it('places a prerelease before its own release', () => {
    expect(compareVersions('6.4.0-rc.1', '6.4.0')).toBeLessThan(0);
    expect(compareVersions('6.4.0', '6.4.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('package surface', () => {
  it('flags an installed version older than the published one', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.3.0',
      fetchLatestVersion: async () => '6.4.0',
      fetch: statusFetch({ pid: 1, version: '6.3.0' }),
    });
    expect(report.problems.map((p) => p.surface)).toContain('package');
  });

  // A maintainer mid-release runs a version the registry has never seen. That
  // is normal, and reporting it as drift is how a report loses its reader.
  it('does not flag an installed version newer than the published one', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0',
      fetchLatestVersion: async () => '6.3.0',
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.problems.map((p) => p.surface)).not.toContain('package');
  });

  it('treats being offline as unknown, not as a problem', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.package.latest).toBeNull();
    expect(report.package.offline).toBe(true);
    expect(report.problems.map((p) => p.surface)).not.toContain('package');
  });

  it('treats a failed registry lookup exactly like being offline', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0',
      fetchLatestVersion: async () => null,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.problems.map((p) => p.surface)).not.toContain('package');
  });
});

describe('daemon surface', () => {
  // The most common real state: installed, never restarted.
  it('flags a daemon running a different version from the installed package', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 99, version: '6.3.0' }),
      lookupPortOwner: () => 99,
    });
    const daemon = report.problems.find((p) => p.surface === 'daemon');
    expect(daemon?.detail).toContain('6.3.0');
    expect(daemon?.fix).toBe('mma restart');
  });

  // doctor runs from whichever package is installed — frequently the stale one.
  // The daemon's version must come from the daemon, never from this process.
  it('reports the version the daemon states, not the CLI it was run from', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 99, version: '6.3.0' }),
      lookupPortOwner: () => 99,
    });
    expect(report.daemon.version).toBe('6.3.0');
  });

  it('flags a daemon that is not running', async () => {
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch(null), isAlive: () => false, lookupPortOwner: () => null,
    });
    expect(report.daemon.running).toBe(false);
    expect(report.problems.map((p) => p.surface)).toContain('daemon');
  });
});

describe('plugin surface', () => {
  it('flags a plugin behind the installed package', async () => {
    withPlugin('mma@multi-model-agent', '5.16.0');
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.plugin).toMatchObject({ key: 'mma@multi-model-agent', version: '5.16.0' });
    expect(report.problems.map((p) => p.surface)).toContain('plugin');
  });

  it('does not flag a plugin at the installed version', async () => {
    withPlugin('mma@multi-model-agent', '6.4.0');
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.problems.map((p) => p.surface)).not.toContain('plugin');
  });

  // Claude Code records "unknown" for a plugin whose manifest carried no
  // version. Reporting that as drift would be a false alarm on every run.
  it('reports an unknown plugin version without calling it drift', async () => {
    withPlugin('mma@multi-model-agent', 'unknown');
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.plugin.version).toBeNull();
    expect(report.problems.map((p) => p.surface)).not.toContain('plugin');
  });

  it('says Claude Code skills come from the plugin rather than showing none', async () => {
    withPlugin('mma@multi-model-agent', '6.4.0');
    const report = await collectReport({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
    });
    expect(report.skills.find((s) => s.client === 'Claude Code')?.providedByPlugin).toBe(true);
  });
});

describe('exit code', () => {
  it('exits zero when every surface agrees', async () => {
    const out: string[] = [];
    const code = await runDoctor({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 1, version: '6.4.0' }),
      stdout: (s) => { out.push(s); return true; },
    });
    expect(code).toBe(DoctorExitCode.HEALTHY);
    expect(out.join('')).toContain('No problems found');
  });

  // The point of the exit code: a script can gate on it.
  it('exits non-zero when a surface disagrees', async () => {
    const out: string[] = [];
    const code = await runDoctor({
      ...base(), cliVersion: '6.4.0', offline: true,
      fetch: statusFetch({ pid: 99, version: '6.3.0' }), lookupPortOwner: () => 99,
      stdout: (s) => { out.push(s); return true; },
    });
    expect(code).toBe(DoctorExitCode.PROBLEMS);
    expect(out.join('')).toContain('mma restart');
  });

  it('emits machine-readable JSON and the same exit code', async () => {
    const out: string[] = [];
    const code = await runDoctor({
      ...base(), cliVersion: '6.4.0', offline: true, json: true,
      fetch: statusFetch({ pid: 99, version: '6.3.0' }), lookupPortOwner: () => 99,
      stdout: (s) => { out.push(s); return true; },
    });
    expect(code).toBe(DoctorExitCode.PROBLEMS);
    const parsed = JSON.parse(out.join('')) as { problems: unknown[]; daemon: { version: string } };
    expect(parsed.daemon.version).toBe('6.3.0');
    expect(parsed.problems.length).toBeGreaterThan(0);
  });
});
