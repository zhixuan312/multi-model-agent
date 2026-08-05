/**
 * Builds a `ProvisioningService` for the CLI surfaces that don't already have
 * a fully-loaded, Zod-validated `ServerConfig` in hand — `mma clients`,
 * `mma mcp install <ClientId>`, `mma sync-skills`, and `mma enable`/`disable`
 * all need to provision against a roster before (or entirely without) a real
 * daemon config existing. `runtime-deps.ts`'s `buildProvisioningService`
 * exists for the ONE daemon-boot call site that already has a validated
 * `ServerConfig`; this is the tolerant counterpart for the CLI, accepting a
 * loosely-typed config so a bare `{}` (no server block yet configured) still
 * builds a working service against sensible defaults.
 *
 * Deliberately NOT imported from `cli/index.ts`: `cli/index.ts` -> (any of
 * sync-skills.ts / toggle.ts / clients.ts) -> here -> `cli/index.ts` would
 * close an import cycle. Same small `resolveCliEntrypoint` duplication
 * `runtime-deps.ts` already carries, for the same reason.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../expand-home.js';
import { readServerVersion } from '../server-version.js';
import { createRealProvisioningPort } from './real-port.js';
import { createProvisioningService, type ProvisioningService } from './service.js';
import type { DeclaredClientRoster } from './roster.js';

/** The subset of config every CLI provisioning call site actually needs —
 *  loose and fully optional so a bare `{}` (no config file loaded/found yet)
 *  still builds a working service against defaults. */
export interface CliProvisioningConfig {
  clients?: DeclaredClientRoster;
  server?: {
    stateDir?: string;
    port?: number;
  };
}

const DEFAULT_STATE_DIR = '~/.mma/state';
const DEFAULT_PORT = 7337;

/** Client-presence hints are read-only and deliberately live beside the CLI
 * provisioning builder. They never affect mutation eligibility: the roster
 * resolves an undeclared detected client to `suggested`, which the service
 * reports but never provisions. */
export function detectCliClients(homeDir: string): ReadonlySet<ClientId> {
  const evidence: ReadonlyArray<readonly [ClientId, string]> = [
    ['claude-code', '.claude'],
    ['claude-desktop', 'Library/Application Support/Claude/claude_desktop_config.json'],
    ['codex', '.codex'],
    ['antigravity', '.gemini'],
    ['cursor', '.cursor'],
    ['vscode', '.vscode'],
    ['opencode', '.config/opencode'],
    ['windsurf', '.codeium/windsurf'],
  ];
  return new Set(evidence.filter(([, relativePath]) => existsSync(join(homeDir, relativePath))).map(([id]) => id));
}

function resolveCliEntrypoint(): string {
  const fromModule = import.meta.url.startsWith('file://') ? fileURLToPath(import.meta.url) : '';
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return realpathSync(resolvePath(argv1));
    } catch { /* fall through to the module path */ }
  }
  return fromModule;
}

interface BuildCliProvisioningServiceOptions {
  /** Overrides `config.clients` for this one call — used by `mma mcp install
   *  <ClientId>` to force ONE client 'on' for the scope of a single
   *  invocation without persisting anything, and by `sync-skills`/`toggle`
   *  to fold explicit `--target`(s) in atop the declared roster. */
  declared?: DeclaredClientRoster;
  stateDir?: string;
  daemonPort?: number;
  cliEntrypoint?: string;
  /** Override host detection in tests; production defaults to the read-only
   * evidence above. */
  detected?: ReadonlySet<ClientId>;
  /** Absolute path of the config file the declared roster lives in. Supplying it
   *  lets the service RE-READ `clients` at the moment it decides whether a
   *  shared skill root still has consumers, rather than trusting the snapshot
   *  taken when this process started. That matters precisely when another
   *  process changed the declaration while this one waited on the provisioning
   *  lock. Without it the snapshot is used, which is what every caller did
   *  before the lock existed. */
  configPath?: string;
}

/** Re-read `clients` from the config file, ignoring anything unreadable or
 *  malformed: a roster we cannot parse is not evidence that a peer went away,
 *  and treating it as such would remove a shared root somebody still uses. */
function declaredFromConfigFile(configPath: string, fallback: DeclaredClientRoster | undefined): DeclaredClientRoster | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const clients = (parsed as { clients?: unknown }).clients;
    if (typeof clients !== 'object' || clients === null) return fallback;
    return clients as DeclaredClientRoster;
  } catch {
    return fallback;
  }
}

export function buildCliProvisioningService(
  config: CliProvisioningConfig,
  homeDir: string = homedir(),
  options: BuildCliProvisioningServiceOptions = {},
): ProvisioningService {
  const stateDir = expandHome(options.stateDir ?? config.server?.stateDir ?? DEFAULT_STATE_DIR, homeDir);
  const port = createRealProvisioningPort({
    homeDir,
    daemonPort: options.daemonPort ?? config.server?.port ?? DEFAULT_PORT,
    cliEntrypoint: options.cliEntrypoint ?? resolveCliEntrypoint(),
    release: readServerVersion(),
    stateDir,
  });
  const declared = options.declared ?? config.clients;
  const configPath = options.configPath;
  return createProvisioningService({
    stateDir,
    port,
    declared,
    detected: options.detected ?? detectCliClients(homeDir),
    // `options.declared` is an explicit per-invocation override (`--target`
    // forcing one client 'on'); re-reading the file would discard it. Only a
    // roster that came FROM the file is re-read from it.
    ...(configPath && !options.declared
      ? { readDeclared: () => declaredFromConfigFile(configPath, declared) }
      : {}),
  });
}
