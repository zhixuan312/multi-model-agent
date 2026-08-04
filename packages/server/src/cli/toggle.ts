/**
 * toggle.ts — `mma disable` / `mma enable` subcommands.
 *
 * Roster-driven (Task I-8): both commands DECLARE `clients.<ClientId>` as
 * `'off'`/`'on'` — persisted to the resolved config file, so a
 * LATER, independent `mma sync-skills` (e.g. the npm postinstall hook) keeps
 * respecting the declaration — and then invoke the same `ProvisioningService`
 * Task I-7 built, replacing the retired `~/.mma/skills-disabled.json`
 * sentinel (`disabled-state.ts`, deleted in Task I-7) as the durable
 * off-switch.
 *
 * `disable`: removes the named clients' registration + skills (ownership-safe
 *   removal via the provisioning service) plus the Claude-Code-only SDLC
 *   commands, and declares them 'off'.
 * `enable`: declares the named clients 'on' and delegates to `sync-skills`'
 *   upsert to (re)install them — including the plugin-supersedes-standalone
 *   and Claude Code commands handling sync-skills already owns.
 *
 * Both reuse sync-skills' `parseArgs`/`resolveTargets`, so `--target=<ClientId>`
 * (repeatable) / `--all-targets` / `--dry-run` / `--json` behave identically
 * across all three commands.
 *
 * Usage:
 *   mma disable [--target=<ClientId>]... [--all-targets] [--dry-run] [--json]
 *   mma enable  [--target=<ClientId>]... [--all-targets] [--dry-run] [--json]
 *
 * Exit codes:
 *   0 — success (or nothing declared/targeted)
 *   1 — one or more clients failed to provision
 *   3 — explicit --target named an unknown ClientId
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { removeCommandFromClaudeCode } from '../provisioning/claude-code-commands.js';
import { buildCliProvisioningService } from '../provisioning/cli-provisioning.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';
import { removeEntry } from '../skill-install/manifest.js';
import { SUPPORTED_COMMANDS, SUPPORTED_SKILLS } from '../skill-install/discover.js';
import { UnknownTargetError, parseArgs, resolveTargets, runSyncSkills } from './sync-skills.js';

export const ToggleExitCode = Object.freeze({
  SUCCESS: 0,
  ERR_PARTIAL: 1,
  ERR_UNKNOWN_TARGET: 3,
});

export interface ToggleDeps {
  argv?: string[];
  homeDir?: string;
  /** Override skills root — threaded into runSyncSkills for `enable` in tests. */
  skillsRoot?: string;
  /** Declared client roster (`config.clients`) BEFORE this command's own
   *  declaration — mirrors sync-skills' `declared`. */
  declared?: DeclaredClientRoster;
  /** Absolute path of the config file to persist `clients.<ClientId>` into.
   *  A mutating enable/disable requires this path: silently performing a
   *  non-durable action would violate the roster contract. */
  configPath?: string;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

/** Merge `{ [id]: state }` for every `targets` into `configPath`'s
 * `clients` map, preserving every other key in the file untouched. */
function persistDeclaredState(configPath: string, targets: ClientId[], state: 'on' | 'off'): void {
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file is not a JSON object: ${configPath}`);
  }
  const raw = parsed as Record<string, unknown>;
  const existingClients = typeof raw.clients === 'object' && raw.clients !== null && !Array.isArray(raw.clients)
    ? (raw.clients as Record<string, unknown>)
    : {};
  const nextClients = { ...existingClients };
  for (const id of targets) nextClients[id] = state;
  const next = { ...raw, clients: nextClients };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

/**
 * `mma disable` — declare the resolved clients 'off', then remove their
 * registration + skills (ownership-safe removal, Task I-7's service) and the
 * Claude-Code-only SDLC commands.
 */
export async function runDisable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mma disable: ${err.message}\n`);
      return ToggleExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  const targets = resolveTargets(parsed.targets, parsed.allTargets, deps.declared);
  if (targets.length === 0) {
    if (parsed.json) {
      stdout(JSON.stringify({ action: 'disable', targets: [], outcome: 'no-clients-declared' }) + '\n');
    } else {
      stdout('No clients declared \'on\'. Use --target=<ClientId> or --all-targets.\n');
    }
    return ToggleExitCode.SUCCESS;
  }

  if (parsed.dryRun) {
    if (parsed.json) {
      stdout(JSON.stringify({ action: 'disable', dryRun: true, targets }) + '\n');
    } else {
      stdout(`Would disable MMA for ${targets.join(', ')}.\n`);
    }
    return ToggleExitCode.SUCCESS;
  }

  if (!deps.configPath) {
    stderr('mma disable: a config file is required to persist clients.<ClientId>; pass --config or create ~/.mma/config.json first.\n');
    return ToggleExitCode.ERR_PARTIAL;
  }

  // Persist the declaration BEFORE removal — the intent is durable even if a
  // client's removal itself fails partway through.
  try {
    persistDeclaredState(deps.configPath, targets, 'off');
  } catch (err) {
    stderr(`mma disable: unable to persist clients.<ClientId>: ${err instanceof Error ? err.message : String(err)}\n`);
    return ToggleExitCode.ERR_PARTIAL;
  }

  const forcedDeclared: DeclaredClientRoster = { ...deps.declared };
  for (const id of targets) forcedDeclared[id] = 'off';
  const service = buildCliProvisioningService({ clients: forcedDeclared }, homeDir, { declared: forcedDeclared });

  const removed: ClientId[] = [];
  const errors: Array<{ clientId: ClientId; reason: string }> = [];

  for (const clientId of targets) {
    try {
      const result = await service.provision([clientId]);
      const status = result.byClient[clientId];
      if (status && status.status !== 'failed') {
        removed.push(clientId);
      } else {
        errors.push({ clientId, reason: `provisioning reported status=${status?.status ?? 'unknown'}` });
      }
    } catch (err) {
      errors.push({ clientId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Claude-Code SDLC commands live outside the provisioning service's skill
  // model — remove them (and their manifest entries) directly, same as
  // sync-skills installs them directly.
  if (removed.includes('claude-code' as ClientId)) {
    for (const command of SUPPORTED_COMMANDS) {
      try {
        removeCommandFromClaudeCode(command, homeDir);
      } catch (err) {
        errors.push({ clientId: 'claude-code' as ClientId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const command of SUPPORTED_COMMANDS) removeEntry(command, ['claude-code' as ClientId], homeDir);
  }

  // Drop each removed client from every skill's manifest targets
  // (client-agnostic install-manifest.json bookkeeping — unaffected by this
  // release; still read by cli/serve.ts's drift warning and skill-drift.ts).
  for (const clientId of removed) {
    for (const skillName of SUPPORTED_SKILLS) removeEntry(skillName, [clientId], homeDir);
  }

  if (parsed.json) {
    stdout(JSON.stringify({ action: 'disable', dryRun: false, targets, removed, errors }) + '\n');
  } else {
    const errClause = errors.length > 0 ? `, ${errors.length} errors` : '';
    stdout(`Disabled MMA for ${removed.join(', ') || '(none)'} (${targets.length} targeted${errClause}).\n`);
    stdout('Run `mma enable` to restore.\n');
    for (const e of errors) stderr(`error: ${e.clientId}: ${e.reason}\n`);
  }

  return errors.length > 0 ? ToggleExitCode.ERR_PARTIAL : ToggleExitCode.SUCCESS;
}

/**
 * `mma enable` — declare the resolved clients 'on', then delegate to
 * sync-skills' idempotent upsert to (re)install them.
 */
export async function runEnable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      (deps.stderr ?? process.stderr.write.bind(process.stderr))(`mma enable: ${err.message}\n`);
      return ToggleExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  const targets = resolveTargets(parsed.targets, parsed.allTargets, deps.declared);
  if (targets.length === 0) {
    const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
    if (parsed.json) {
      stdout(JSON.stringify({ action: 'enable', targets: [], outcome: 'no-clients-declared' }) + '\n');
    } else {
      stdout('No clients declared. Use --target=<ClientId> or --all-targets.\n');
    }
    return ToggleExitCode.SUCCESS;
  }

  if (!parsed.dryRun) {
    const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
    if (!deps.configPath) {
      stderr('mma enable: a config file is required to persist clients.<ClientId>; pass --config or create ~/.mma/config.json first.\n');
      return ToggleExitCode.ERR_PARTIAL;
    }
    try {
      persistDeclaredState(deps.configPath, targets, 'on');
    } catch (err) {
      stderr(`mma enable: unable to persist clients.<ClientId>: ${err instanceof Error ? err.message : String(err)}\n`);
      return ToggleExitCode.ERR_PARTIAL;
    }
  }

  const forcedDeclared: DeclaredClientRoster = { ...deps.declared };
  for (const id of targets) forcedDeclared[id] = 'on';

  return runSyncSkills({
    argv,
    homeDir,
    skillsRoot: deps.skillsRoot,
    declared: forcedDeclared,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}
