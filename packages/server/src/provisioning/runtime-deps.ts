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

/**
 * What this builder actually needs: a server block, and OPTIONALLY the declared client roster that
 * only a full `MultiModelConfig` carries.
 *
 * Declaring plain `ServerConfig` and reaching for `clients` through
 * `config as unknown as { clients?: … }` meant one caller cast a `MultiModelConfig` DOWN to
 * `ServerConfig` to call this, and this cast it back UP to read the field — two casts that
 * cancelled out, with the compiler checking neither end.
 */
type ProvisioningConfig = ServerConfig & { clients?: DeclaredClientRoster };

export function buildProvisioningService(config: ProvisioningConfig): ProvisioningService {
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
    declared: config.clients,
    // Deliberately EMPTY, not an oversight. The daemon consumes `inventory()` for exactly one
    // thing — filtering `status === 'failed'` for the /health drift report — and detection only
    // ever promotes an undeclared client from 'off' to 'suggested', neither of which is 'failed'.
    // Wiring `detectCliClients` here would add a filesystem scan to every /health for a
    // distinction this caller discards. The CLI surface, which DOES show 'suggested', passes a
    // real detected set (see `cli-provisioning.ts`).
    detected: new Set(),
  };
  return createProvisioningService(deps);
}
