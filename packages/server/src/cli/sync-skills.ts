/**
 * sync-skills.ts — `mma sync-skills` subcommand.
 *
 * Roster-driven: provisions every DECLARED-'on' client
 * (`config.clients`) through the shared `ProvisioningService` — registration
 * AND skills together, atomically, per client —
 * plus the Claude-Code-only SDLC commands (`mma-flow`, `mma-breakout`) that
 * live outside the provisioning service's skill-root model (relocated to
 * `provisioning/claude-code-commands.ts`).
 *
 * An explicit `--target=<ClientId>` (repeatable) or `--all-targets` FORCES
 * those clients regardless of declared state — the same one-off-override
 * shape as `mma mcp install <ClientId>`. With neither flag, only the
 * declared-'on' roster is touched: a detected-but-undeclared client is
 * reported 'suggested' and NEVER mutated (FR-7a) — detection alone must
 * never provision.
 *
 * Usage:
 *   mma sync-skills [--target=<ClientId>]... [--all-targets] [--dry-run] [--json]
 *                    [--keep-standalone] [--silent] [--best-effort] [--if-exists]
 *
 * Exit codes:
 *   0 — success (or nothing declared/targeted)
 *   1 — one or more clients/commands failed to provision
 *   2 — manifest was written by a newer mma (FutureManifestError)
 *   3 — explicit --target named an unknown ClientId
 */
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import matter from 'gray-matter';
import { CLIENT_IDS, type ClientId } from '@zhixuan92/multi-model-agent-core';
import { recordProvisionedSkills } from '../skill-install/record-provisioned.js';
import {
  listEntries,
  versionFromContent,
  removeEntry,
  manifestPath,
  FutureManifestError,
  type ManifestEntry,
} from '../skill-install/manifest.js';
import { findEnabledMmaPlugin, pluginSupersedesMessage } from '../skill-install/plugin-conflict.js';
import {
  SUPPORTED_SKILLS,
  SUPPORTED_COMMANDS,
  readSkillContent,
  readCommandContent,
  getSkillsRoot,
} from '../skill-install/discover.js';
import {
  writeCommandToClaudeCode,
  removeCommandFromClaudeCode,
  removeStandaloneClaudeCodeSkill,
} from '../provisioning/claude-code-commands.js';
import { buildCliProvisioningService, detectCliClients } from '../provisioning/cli-provisioning.js';
import { resolveEffectiveRoster, type DeclaredClientRoster } from '../provisioning/roster.js';

export const ExitCode = Object.freeze({
  SUCCESS: 0,
  ERR_PARTIAL: 1,
  ERR_FUTURE_MANIFEST: 2,
  ERR_UNKNOWN_TARGET: 3,
});

export class UnknownTargetError extends Error {
  readonly code = 'unknown_target' as const;
  constructor(target: string, valid: readonly string[]) {
    super(`Unknown target '${target}'. Valid: ${valid.join(', ')}`);
  }
}

interface SyncSkillsDeps {
  argv?: string[];
  homeDir?: string;
  /** Override skills root for testing. */
  skillsRoot?: string;
  /** Exit silently with code 0 if no manifest exists yet (postinstall). */
  ifExists?: boolean;
  /** Suppress normal stdout. Errors still go to stderr. */
  silent?: boolean;
  /** Swallow errors and exit 0 (postinstall). */
  bestEffort?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  /** Declared client roster (`config.clients`). Threaded in by cli/index.ts /
   *  cli/serve.ts from the loaded config; omitted means nothing is
   *  declared, so ONLY explicit --target(s)/--all-targets get provisioned. */
  declared?: DeclaredClientRoster;
  /** Test-only: detected-but-undeclared clients, reported as 'suggested' and
   *  NEVER provisioned (FR-7a). Defaults to empty — matches every other
   *  production provisioning call site in this release (`runtime-deps.ts`,
   *  `cli-provisioning.ts`); real host detection is not yet implemented. */
  detected?: ReadonlySet<ClientId>;
  /** Test/advanced overrides for the provisioning port's context. */
  daemonPort?: number;
  cliEntrypoint?: string;
  stateDir?: string;
}

interface ParsedArgs {
  targets: ClientId[] | null;
  allTargets: boolean;
  dryRun: boolean;
  json: boolean;
  /** Opt out of the plugin-supersedes-standalone retirement. */
  keepStandalone: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = minimist(argv, {
    string: ['target'],
    boolean: ['dry-run', 'json', 'all-targets', 'keep-standalone'],
    alias: { t: 'target', j: 'json' },
  });
  let targets: ClientId[] | null = null;
  if (args.target) {
    const t = Array.isArray(args.target) ? args.target : [args.target];
    for (const candidate of t as string[]) {
      if (!(CLIENT_IDS as readonly string[]).includes(candidate)) {
        throw new UnknownTargetError(candidate, CLIENT_IDS);
      }
    }
    targets = t as ClientId[];
  }
  return {
    targets,
    allTargets: args['all-targets'] === true,
    dryRun: args['dry-run'] === true,
    json: args['json'] === true,
    keepStandalone: args['keep-standalone'] === true,
  };
}

/**
 * Resolves which clients this run should provision.
 *
 * An explicit `--target`/`--all-targets` is a FORCED override — exactly like
 * `mma mcp install <ClientId>` — regardless of the declared roster. With
 * neither, only the declared-'on' roster is returned; a detected-but-
 * undeclared client is never included here (see `resolveSuggested`).
 */
export function resolveTargets(
  explicit: ClientId[] | null,
  allTargets: boolean,
  declared: DeclaredClientRoster | undefined,
  detected: ReadonlySet<ClientId> = new Set(),
): ClientId[] {
  if (allTargets) return [...CLIENT_IDS];
  if (explicit !== null) return Array.from(new Set(explicit));
  const roster = resolveEffectiveRoster(declared, detected);
  return roster.filter((entry) => entry.effectiveState === 'on').map((entry) => entry.clientId);
}

/** Detected-but-undeclared clients — reported only, never provisioned. */
function resolveSuggested(declared: DeclaredClientRoster | undefined, detected: ReadonlySet<ClientId>): ClientId[] {
  return resolveEffectiveRoster(declared, detected)
    .filter((entry) => entry.effectiveState === 'suggested')
    .map((entry) => entry.clientId);
}

function manifestPresent(homeDir: string): boolean {
  return fs.existsSync(manifestPath(homeDir));
}

function readInstalledVersionAt(skillFile: string): string | null {
  try {
    return versionFromContent(fs.readFileSync(skillFile, 'utf8'));
  } catch {
    return null;
  }
}

interface SyncOutcome {
  provisioned: ClientId[];
  suggested: ClientId[];
  errors: Array<{ clientId: ClientId; reason: string }>;
  commands: { installed: string[]; removed: string[] };
}

export async function runSyncSkills(deps: SyncSkillsDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const skillsRoot = getSkillsRoot(deps.skillsRoot);
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const silent = deps.silent ?? false;
  const bestEffort = deps.bestEffort ?? false;
  const log = silent ? (_: string) => true : stdout;

  if (deps.ifExists && !manifestPresent(homeDir)) return ExitCode.SUCCESS;

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mma sync-skills: ${err.message}\n`);
      return bestEffort ? 0 : ExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  const detected = deps.detected ?? detectCliClients(homeDir);
  const suggested = resolveSuggested(deps.declared, detected);
  let targets = resolveTargets(parsed.targets, parsed.allTargets, deps.declared, detected);

  if (targets.length === 0) {
    if (parsed.json) {
      stdout(JSON.stringify({ targets: [], suggested, outcome: 'no-clients-declared' }) + '\n');
    } else {
      log('No clients declared \'on\'. Use --target=<ClientId>, --all-targets, or set clients.<id>="on" in config.\n');
      if (suggested.length > 0) log(`Detected but undeclared (reported only, not installed): ${suggested.join(', ')}\n`);
    }
    return ExitCode.SUCCESS;
  }

  // ── Plugin supersedes standalone (Claude Code only) ──────────────────────
  // Claude Code namespaces plugin components instead of replacing standalone
  // ones, so having both means two copies of every skill with near-identical
  // descriptions and arbitrary intent-matching. The plugin is a strict superset
  // (skills + commands + MCP), so when it is present the standalone install is
  // retired: remove MMA's own ~/.claude entries so this run does not recreate
  // the duplicate.
  //
  // Strictly one-directional — see pluginSupersedesMessage for why this must
  // never uninstall the plugin instead. This retirement predates — and is
  // orthogonal to — the ownership-marker system the provisioning service uses
  // for everything else, so it removes raw files directly rather than routing
  // through the ownership-safe port (a pre-I-4 standalone install never had a
  // marker to prove ownership with).
  const supersedingPlugin = targets.includes('claude-code' as ClientId) && !parsed.keepStandalone
    ? findEnabledMmaPlugin(homeDir)
    : null;
  if (supersedingPlugin) {
    const presentSkills = SUPPORTED_SKILLS
      .filter((skill) => readInstalledVersionAt(path.join(homeDir, '.claude', 'skills', skill, 'SKILL.md')) !== null);
    const presentCommands = SUPPORTED_COMMANDS
      .filter((command) => readInstalledVersionAt(path.join(homeDir, '.claude', 'commands', `${command}.md`)) !== null);
    const retired = presentSkills.length + presentCommands.length;

    if (!parsed.dryRun) {
      for (const skill of presentSkills) {
        try { removeStandaloneClaudeCodeSkill(skill, homeDir); } catch { /* best-effort */ }
      }
      for (const command of presentCommands) {
        try { removeCommandFromClaudeCode(command, homeDir); } catch { /* best-effort */ }
      }
      for (const name of [...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS]) {
        removeEntry(name, ['claude-code' as ClientId], homeDir);
      }
    }
    targets = targets.filter((t) => t !== 'claude-code');

    if (parsed.json) {
      stdout(JSON.stringify({
        outcome: 'plugin-supersedes-standalone',
        plugin: supersedingPlugin,
        target: 'claude-code',
        retired,
        dryRun: parsed.dryRun,
      }) + '\n');
    } else {
      log(pluginSupersedesMessage(supersedingPlugin, retired));
    }
    if (targets.length === 0) return ExitCode.SUCCESS;
  }

  if (parsed.dryRun) {
    if (parsed.json) {
      stdout(JSON.stringify({ dryRun: true, targets, suggested }) + '\n');
    } else {
      const commandCount = targets.includes('claude-code' as ClientId) ? SUPPORTED_COMMANDS.length : 0;
      log(`Would sync ${targets.length + commandCount} asset(s) → ${targets.join(', ')}.\n`);
      if (suggested.length > 0) log(`Detected but undeclared (reported only, not installed): ${suggested.join(', ')}\n`);
    }
    return ExitCode.SUCCESS;
  }

  let manifestEntries: ManifestEntry[];
  try {
    manifestEntries = listEntries(homeDir);
  } catch (err) {
    if (err instanceof FutureManifestError) {
      stderr(`mma sync-skills: ${err.message}\n`);
      return bestEffort ? 0 : ExitCode.ERR_FUTURE_MANIFEST;
    }
    if (bestEffort) return 0;
    throw err;
  }

  const outcome: SyncOutcome = { provisioned: [], suggested, errors: [], commands: { installed: [], removed: [] } };

  // Full registration + skills provisioning per client, via the shared
  // ProvisioningService. Forcing `targets` to 'on' for the scope
  // of THIS call mirrors `mma mcp install <ClientId>` — an explicit --target
  // always wins, never persisted. Each client runs independently (never
  // batched into one provision() call) so one client's failure — including a
  // thrown ownership-conflict error, which the port raises rather than
  // returns for pre-existing unmarked content — can never stop or corrupt a
  // sibling's outcome.
  const forcedDeclared: DeclaredClientRoster = { ...deps.declared };
  for (const id of targets) forcedDeclared[id] = 'on';
  const service = buildCliProvisioningService(
    { clients: forcedDeclared },
    homeDir,
    {
      declared: forcedDeclared,
      ...(deps.stateDir !== undefined && { stateDir: deps.stateDir }),
      ...(deps.daemonPort !== undefined && { daemonPort: deps.daemonPort }),
      ...(deps.cliEntrypoint !== undefined && { cliEntrypoint: deps.cliEntrypoint }),
    },
  );

  for (const clientId of targets) {
    try {
      const result = await service.provision([clientId]);
      const status = result.byClient[clientId];
      if (status && status.status !== 'failed') {
        outcome.provisioned.push(clientId);
      } else {
        outcome.errors.push({ clientId, reason: `provisioning reported status=${status?.status ?? 'unknown'}` });
      }
    } catch (err) {
      outcome.errors.push({ clientId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Manifest bookkeeping reflects clients that were ACTUALLY provisioned this
  // run. Shared with `mma mcp install` so both provisioning entry points leave
  // the same record — see `skill-install/record-provisioned.ts`.
  outcome.errors.push(...recordProvisionedSkills(outcome.provisioned, skillsRoot, homeDir));

  // Orphan manifest cleanup: entries for skills the bundle no longer ships.
  for (const entry of manifestEntries) {
    if ((SUPPORTED_SKILLS as readonly string[]).includes(entry.name)) continue;
    removeEntry(entry.name, [], homeDir);
  }

  // Claude Code SDLC commands — only when claude-code was ACTUALLY
  // provisioned this run (never when superseded by the plugin above, and
  // never when it merely failed).
  const claudeCodeProvisioned = outcome.provisioned.includes('claude-code' as ClientId);
  if (claudeCodeProvisioned) {
    for (const commandName of SUPPORTED_COMMANDS) {
      const content = readCommandContent(commandName, skillsRoot);
      if (content === null) {
        outcome.errors.push({
          clientId: 'claude-code' as ClientId,
          reason: `Bundled command SKILL.md not found for '${commandName}' at ${path.join(skillsRoot, commandName, 'SKILL.md')}`,
        });
        continue;
      }
      try {
        writeCommandToClaudeCode(commandName, content, homeDir, skillsRoot);
        outcome.commands.installed.push(commandName);
      } catch (err) {
        outcome.errors.push({ clientId: 'claude-code' as ClientId, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Orphan command cleanup — remove commands no longer in SUPPORTED_COMMANDS
    // but previously installed.
    const commandsDir = path.join(homeDir, '.claude', 'commands');
    try {
      for (const file of fs.readdirSync(commandsDir)) {
        if (!file.startsWith('mma-') || !file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        if (!(SUPPORTED_COMMANDS as readonly string[]).includes(name)) {
          removeCommandFromClaudeCode(name, homeDir);
          outcome.commands.removed.push(name);
        }
      }
    } catch { /* commands dir may not exist yet */ }
  }

  const totalAssets = outcome.provisioned.length + outcome.commands.installed.length;

  if (parsed.json) {
    stdout(JSON.stringify({ targets, suggested, outcome }) + '\n');
  } else {
    const parts: string[] = [];
    if (outcome.provisioned.length > 0) parts.push(`${outcome.provisioned.length} client(s) provisioned`);
    if (outcome.commands.installed.length > 0) parts.push(`${outcome.commands.installed.length} command(s) installed`);
    if (outcome.commands.removed.length > 0) parts.push(`${outcome.commands.removed.length} command(s) removed`);
    if (outcome.errors.length > 0) parts.push(`${outcome.errors.length} errors`);
    const summary = parts.length > 0 ? parts.join(', ') : 'nothing to do';
    log(`Synced ${totalAssets} asset(s) → ${targets.join(', ')} (${summary}).\n`);
    if (suggested.length > 0) log(`Detected but undeclared (reported only, not installed): ${suggested.join(', ')}\n`);
    for (const e of outcome.errors) stderr(`error: ${e.clientId}: ${e.reason}\n`);
  }

  if (outcome.errors.length > 0) return bestEffort ? 0 : ExitCode.ERR_PARTIAL;
  return ExitCode.SUCCESS;
}
