/**
 * Builds the production `ProvisioningServiceDeps` the daemon boot sequence
 * (`http/server.ts`) and `cli/serve.ts`'s startup drift check both need --
 * ONE place resolving home directory, state directory, and the declared
 * `clients` roster from config, so `GET /health`, the boot warning, and
 * daemon-start recovery can never quietly disagree about what "the current
 * client roster" means.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../expand-home.js';
import { readServerVersion } from '../server-version.js';
import { createRealProvisioningPort } from './real-port.js';
import { createProvisioningService, type ProvisioningService, type ProvisioningServiceDeps } from './service.js';
import type { DeclaredClientRoster } from './roster.js';

/**
 * Deliberately NOT imported from `cli/index.ts` (which exports the same
 * logic as `resolveCliEntrypoint`): `cli/index.ts` -> `cli/serve.ts` ->
 * `http/server.ts` -> here would close an import cycle back to `cli/index.ts`.
 * Small enough to keep as its own copy rather than restructure that chain.
 */
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

/** `config.clients` when `config` is a full `MultiModelConfig` (agents
 *  present); `undefined` for a bare `ServerConfig` (no declared roster). */
function declaredRosterOf(config: ServerConfig): DeclaredClientRoster | undefined {
  return (config as unknown as { clients?: DeclaredClientRoster }).clients;
}

export function buildProvisioningService(config: ServerConfig): ProvisioningService {
  const homeDir = homedir();
  const stateDir = expandHome(config.server.stateDir);
  const port = createRealProvisioningPort({
    homeDir,
    daemonPort: config.server.port,
    cliEntrypoint: resolveCliEntrypoint(),
    release: readServerVersion(),
    stateDir,
  });
  const deps: ProvisioningServiceDeps = {
    stateDir,
    port,
    declared: declaredRosterOf(config),
    detected: new Set(),
  };
  return createProvisioningService(deps);
}
