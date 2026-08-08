/**
 * doctor.ts — `mma doctor`.
 *
 * A read-only report of every surface an update can leave behind, and of any
 * disagreement between them.
 *
 * WHY IT EXISTS. An MMA install is not one version, it is five: the npm
 * package, the running daemon, the Claude Code plugin, the skill files on disk,
 * and each client's MCP registration. Nothing compared them, so a partial
 * update was invisible — a machine could run a 6.2.0 package, a 6.3.0 daemon and
 * a 5.16.0 plugin for days without a single message saying so. Skew is not
 * cosmetic: a skill file from an older release can send a payload the current
 * request schema rejects, and the user sees an unexplained 400.
 *
 * WHY IT READS THE DAEMON'S OWN VERSION. `mma doctor` runs from whichever
 * package version happens to be installed, which is frequently the STALE one —
 * that is the condition being diagnosed. So the daemon's version always comes
 * from its own GET /status, never from this process. Reporting the CLI's version
 * as the daemon's is exactly the mistake this command exists to catch.
 *
 * WHY IT GOES TO THE NETWORK. "Am I behind?" is the question it is for, and
 * that cannot be answered from local state alone. `npm install` already contacts
 * the same registry, so this reveals nothing new about the user, and MMA
 * telemetry is not involved. Offline is not a problem: the latest version is
 * reported as unknown and every local comparison still runs.
 *
 * EXIT CODE. Non-zero when at least one problem is found, so a script can gate
 * on it. Drift is a problem; being offline is not.
 */
import * as path from 'node:path';
import { CLIENT_CAPABILITIES } from '../provisioning/capability-registry.js';
import { findEnabledMmaPlugin, readInstalledPluginVersion } from '../skill-install/plugin-conflict.js';
import { listEntries, FutureManifestError, type ManifestEntry } from '../skill-install/manifest.js';
import { isSkillBehind } from '../skill-install/skill-drift.js';
import { probeStatus, resolveDaemon, type DaemonControlDeps } from './daemon-control.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';

/** The npm name whose published version answers "am I behind?". */
export const PACKAGE_NAME = '@zhixuan92/multi-model-agent';

export interface DoctorDeps extends DaemonControlDeps {
  /** Version of the package this process is running from. */
  cliVersion: string;
  /** Home directory (skills, plugin records, registrations all hang off it). */
  homeDir: string;
  json?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  /** Budget for the registry lookup. Short on purpose — doctor must stay usable offline. */
  registryTimeoutMs?: number;
  /** Skip the network entirely. Used by tests and by --offline. */
  offline?: boolean;
  /** Test seam replacing the registry lookup. */
  fetchLatestVersion?: (pkg: string) => Promise<string | null>;
  /** The declared client roster (`config.clients`). Undefined means the config
   *  could not be read, which is reported as unknown rather than as "nothing
   *  declared" — those are different states. */
  declared?: DeclaredClientRoster;
}

export interface DoctorProblem {
  surface: string;
  detail: string;
  fix: string;
}

export interface DoctorReport {
  package: { installed: string; latest: string | null; offline: boolean };
  daemon: { running: boolean; version: string | null; pid: number | null; uptimeMs: number | null };
  plugin: { key: string | null; version: string | null };
  skills: Array<{ client: string; count: number; version: string | null; behind: number; providedByPlugin: boolean }>;
  registrations: Array<{ client: string; status: string }>;
  problems: DoctorProblem[];
}

export const DoctorExitCode = { HEALTHY: 0, PROBLEMS: 1 } as const;

/** Ask the npm registry for the published version. Null on any failure. */
async function fetchLatestFromRegistry(
  pkg: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The `/latest` document is a few hundred bytes; the full packument is
    // megabytes for a package with this many releases.
    const res = await fetcher(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Order two versions: negative when `a` precedes `b`, 0 when equal.
 *
 * Enough semver for the one question asked here — is the installed package
 * older than the published one. Compares the numeric release triple, then
 * treats a prerelease as preceding its own release (`6.4.0-rc.1` < `6.4.0`), as
 * semver requires. Hand-written because the server package has no semver
 * dependency and adding one to answer this would be a poor trade.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core = '', ...rest] = v.split('-');
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join('-'),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;   // release beats its own prerelease
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The first line of an error message, capped. Keeps one broken file from
 *  burying every other finding under a wall of validator output. */
function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Drop a trailing opener left behind when the rest of a multi-line structure
  // is cut away, so the line does not end mid-syntax.
  const line = (msg.split('\n')[0] ?? msg).replace(/[\s:[{(]+$/, '');
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

/** Human label for a client id, so the report reads as prose rather than slugs. */
const CLIENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  vscode: 'VS Code',
  opencode: 'opencode',
  windsurf: 'Windsurf',
};

const label = (id: string): string => CLIENT_LABEL[id] ?? id;

export async function collectReport(deps: DoctorDeps): Promise<DoctorReport> {
  const fetcher = deps.fetch ?? fetch;
  const problems: DoctorProblem[] = [];

  // ── package ────────────────────────────────────────────────────────────
  const offline = deps.offline === true;
  const latest = offline
    ? null
    : await (deps.fetchLatestVersion ?? ((p: string) =>
        fetchLatestFromRegistry(p, fetcher, deps.registryTimeoutMs ?? 3000)))(PACKAGE_NAME);
  // Only BEHIND is a problem. Installed > published is a maintainer running an
  // unreleased build, which is a normal state and must not be reported as drift
  // — flagging it would train the one person who reads this report to ignore it.
  if (latest !== null && compareVersions(deps.cliVersion, latest) < 0) {
    problems.push({
      surface: 'package',
      detail: `installed ${deps.cliVersion}, latest published ${latest}`,
      fix: 'mma update',
    });
  }

  // ── daemon ─────────────────────────────────────────────────────────────
  const daemon = await resolveDaemon(deps);
  const status = daemon?.reachable ? await probeStatus(deps.serverUrl, deps.token, fetcher) : null;
  const daemonVersion = status?.version ?? daemon?.version ?? null;
  if (daemon === null) {
    problems.push({ surface: 'daemon', detail: 'not running', fix: 'mma serve' });
  } else if (daemonVersion !== null && daemonVersion !== deps.cliVersion) {
    // The daemon still runs the code it was started with. This is the single
    // most common real state after an install with no restart.
    problems.push({
      surface: 'daemon',
      detail: `running ${daemonVersion}, installed package is ${deps.cliVersion}`,
      fix: 'mma restart',
    });
  }

  // ── plugin ─────────────────────────────────────────────────────────────
  const pluginKey = findEnabledMmaPlugin(deps.homeDir);
  const pluginVersion = pluginKey ? readInstalledPluginVersion(deps.homeDir, pluginKey) : null;
  if (pluginKey && pluginVersion !== null && pluginVersion !== deps.cliVersion) {
    problems.push({
      surface: 'plugin',
      detail: `${pluginKey} is ${pluginVersion}, installed package is ${deps.cliVersion}`,
      fix: 'mma update (or: claude plugin update ' + pluginKey + ')',
    });
  }

  // ── skill files ────────────────────────────────────────────────────────
  let entries: ManifestEntry[] = [];
  try {
    entries = listEntries(deps.homeDir);
  } catch (err) {
    // Structural validation failures carry the whole Zod issue array, which is
    // hundreds of lines of JSON. A report that scrolls the real findings off
    // the screen is worse than one that names the file and stops.
    problems.push({
      surface: 'skills',
      detail: err instanceof FutureManifestError
        ? err.message
        : `install manifest is unreadable: ${firstLine(err)}`,
      fix: 'mma sync-skills (or remove ~/.mma/install-manifest.json and re-run it)',
    });
  }

  const byClient = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    for (const target of entry.targets) {
      const list = byClient.get(target) ?? [];
      list.push(entry);
      byClient.set(target, list);
    }
  }

  const skills: DoctorReport['skills'] = [];
  // Claude Code is reported even with no manifest entries, because "the plugin
  // provides them" is the CORRECT state there and silence would read as broken.
  const clientIds = new Set<string>([...byClient.keys()]);
  if (pluginKey) clientIds.add('claude-code');
  for (const client of [...clientIds].sort()) {
    const list = byClient.get(client) ?? [];
    const behind = list.filter((e) => isSkillBehind(e.name, e.skillVersion));
    const providedByPlugin = client === 'claude-code' && pluginKey !== null && list.length === 0;
    skills.push({
      client: label(client),
      count: list.length,
      version: list[0]?.skillVersion ?? null,
      behind: behind.length,
      providedByPlugin,
    });
    if (behind.length > 0) {
      problems.push({
        surface: `skills/${client}`,
        detail: `${behind.length} skill file(s) are out of date`,
        // Name the target explicitly. A bare `mma sync-skills` only touches
        // clients DECLARED 'on' in config.clients, so on a machine with an
        // empty roster the bare form is a silent no-op — advice that does
        // nothing is worse than no advice.
        fix: `mma sync-skills --target=${client}`,
      });
    }
  }

  // ── declared roster ────────────────────────────────────────────────────
  // The DECLARED state from config.clients, not the capability registry. An
  // earlier version listed every client MMA is capable of writing to and
  // labelled them all "declared", which read as "all set up" on a machine
  // where nothing was declared at all — and a bare `mma sync-skills` on such a
  // machine does nothing, so the report and the advice were wrong together.
  const registrations = CLIENT_CAPABILITIES
    .filter((c) => c.mcpConfigPaths.length > 0)
    .map((c) => ({
      client: label(c.id),
      status: deps.declared?.[c.id] === 'on' ? 'on'
        : deps.declared?.[c.id] === 'off' ? 'off (pinned)'
          : 'not declared',
    }));
  // Deliberately NOT a problem on its own. A Claude-Code-via-plugin user is
  // fully set up with an empty roster, so flagging it would cry wolf at the
  // most common configuration. The consequence that DOES matter — skill files
  // going stale because routine syncs skip an undeclared client — is already
  // reported by the drift check above, with the target named in the fix.

  return {
    package: { installed: deps.cliVersion, latest, offline: offline || latest === null },
    daemon: {
      running: daemon !== null,
      version: daemonVersion,
      pid: daemon?.pid ?? null,
      uptimeMs: status?.uptimeMs ?? null,
    },
    plugin: { key: pluginKey, version: pluginVersion },
    skills,
    registrations,
    problems,
  };
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const report = await collectReport(deps);

  if (deps.json === true) {
    stdout(JSON.stringify(report, null, 2) + '\n');
    return report.problems.length > 0 ? DoctorExitCode.PROBLEMS : DoctorExitCode.HEALTHY;
  }

  const flagged = (surface: string): string =>
    report.problems.some((p) => p.surface === surface || p.surface.startsWith(surface + '/'))
      ? '  BEHIND'
      : '';

  // Trailing space before the dots so the label reads as a label, not as one
  // long run-on token.
  const pad = (s: string): string => (s + ' ').padEnd(14, '.');

  stdout('\n');
  const latestNote = report.package.latest === null
    ? '(latest unknown, offline)'
    : report.package.latest === report.package.installed
      ? '(latest)'
      : compareVersions(report.package.installed, report.package.latest) > 0
        // A maintainer's unreleased build. Say so, rather than showing a lower
        // number next to "latest" and leaving the reader to work out which way round it is.
        ? `(unreleased; latest published ${report.package.latest})`
        : `(latest ${report.package.latest})`;
  stdout(`  ${pad('Package')} ${report.package.installed}  ${latestNote}${flagged('package')}\n`);

  if (!report.daemon.running) {
    stdout(`  ${pad('Daemon')} not running\n`);
  } else {
    const uptime = report.daemon.uptimeMs !== null ? `, uptime ${formatUptime(report.daemon.uptimeMs)}` : '';
    stdout(`  ${pad('Daemon')} ${report.daemon.version ?? 'unknown'}  pid ${report.daemon.pid}${uptime}${flagged('daemon')}\n`);
  }

  if (report.plugin.key !== null) {
    stdout(`  ${pad('Plugin')} ${report.plugin.version ?? 'unknown'}  ${report.plugin.key}${flagged('plugin')}\n`);
  }

  if (report.skills.length > 0) {
    stdout(`  Skill files\n`);
    for (const s of report.skills) {
      const detail = s.providedByPlugin
        ? 'provided by the plugin'
        : `${s.count} files, ${s.version ?? 'unknown'}${s.behind > 0 ? `, ${s.behind} out of date` : ''}`;
      stdout(`    ${s.client.padEnd(16, ' ')}${detail}\n`);
    }
  }

  if (report.registrations.length > 0) {
    stdout(`  Declared clients\n`);
    for (const r of report.registrations) {
      stdout(`    ${r.client.padEnd(16, ' ')}${r.status}\n`);
    }
  }

  stdout('\n');
  if (report.problems.length === 0) {
    stdout('  No problems found.\n\n');
    return DoctorExitCode.HEALTHY;
  }
  const noun = report.problems.length === 1 ? 'problem' : 'problems';
  stdout(`  ${report.problems.length} ${noun}:\n`);
  for (const p of report.problems) {
    stdout(`    ${p.surface}: ${p.detail}\n      fix: ${p.fix}\n`);
  }
  stdout('\n');
  return DoctorExitCode.PROBLEMS;
}
