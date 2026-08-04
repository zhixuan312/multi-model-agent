/**
 * clients.ts — `mma clients` and `mma mcp install <ClientId>`.
 *
 * `mma clients` prints the SAME eight-record inventory `inventory.ts` already
 * computes (`provisioning/inventory.ts`, via the provisioning service) — this
 * module adds NO new inventory logic, only a human/JSON rendering of it.
 *
 * `mma mcp install <ClientId>` runs that ONE client's full provisioning
 * (registration + skills) through the same service. It is an explicit,
 * one-off user action: unlike `mma sync-skills`/`mma enable`, it forces the
 * named client 'on' for the scope of THIS call without persisting anything
 * to config — the only gate is an explicit `clients.<id> = 'off'`
 * declaration, which it refuses rather than overrides.
 */
import * as os from 'node:os';
import { CLIENT_IDS, type ClientId } from '@zhixuan92/multi-model-agent-core';
import { buildCliProvisioningService, type CliProvisioningConfig } from '../provisioning/cli-provisioning.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';
import type { ClientInventoryRecord } from '../provisioning/inventory.js';
import type { ClientProvisioningStatus } from '../provisioning/provisioning-port.js';

interface ClientsCommandDeps {
  json: boolean;
  config: CliProvisioningConfig;
  homeDir?: string;
}

/** Render one line per client: declared/effective status, skills, MCP
 *  registration — straight from `ClientProvisioningStatus`, no new fields. */
function formatRecord(record: ClientInventoryRecord): string {
  return `${record.clientId}\tdeclared=${record.declaredState ?? 'undeclared'}\tdetected=${record.detectedPresence}\tstatus=${record.status}\tskills=${record.skillsInstalled}\tmcp=${record.mcpRegistrationStatus}`;
}

/** `mma clients` / `mma clients --json`. */
export async function runClientsCommand(deps: ClientsCommandDeps): Promise<string> {
  const homeDir = deps.homeDir ?? os.homedir();
  const service = buildCliProvisioningService(deps.config, homeDir);
  const records = await service.inventory();
  if (deps.json) return JSON.stringify(records);
  return records.map(formatRecord).join('\n') + '\n';
}

type McpInstallErrorCode = 'client_id_required' | 'unknown_client' | 'client_declared_off' | 'provisioning_failed';

/** Thrown by `runMcpInstallCommand` for every refusal — `code` is the
 *  checkable signal callers (the CLI's exit-code mapping, tests) key off. */
export class McpInstallCliError extends Error {
  readonly code: McpInstallErrorCode;
  constructor(code: McpInstallErrorCode, message: string) {
    super(message);
    this.name = 'McpInstallCliError';
    this.code = code;
  }
}

interface McpInstallDeps {
  clientId: string | undefined;
  config: CliProvisioningConfig;
  homeDir?: string;
}

interface McpInstallResult {
  clientId: ClientId;
  status: ClientProvisioningStatus['status'];
}

/** `mma mcp install <ClientId>`. Validation (missing/unknown ID, declared
 *  'off') happens BEFORE anything provisioning-related is touched, so a bare
 *  `{ clientId: undefined, config: {} }` rejects deterministically without
 *  ever needing `config.server` to be populated. */
export async function runMcpInstallCommand(deps: McpInstallDeps): Promise<McpInstallResult> {
  if (!deps.clientId) {
    throw new McpInstallCliError(
      'client_id_required',
      `A client ID is required. Valid IDs: ${CLIENT_IDS.join(', ')}`,
    );
  }
  if (!(CLIENT_IDS as readonly string[]).includes(deps.clientId)) {
    throw new McpInstallCliError(
      'unknown_client',
      `Unknown client '${deps.clientId}'. Valid IDs: ${CLIENT_IDS.join(', ')}`,
    );
  }
  const clientId = deps.clientId as ClientId;
  if (deps.config.clients?.[clientId] === 'off') {
    throw new McpInstallCliError(
      'client_declared_off',
      `clients.${clientId} is set to 'off'. Set it to 'on' first (e.g. run \`mma enable --target=${clientId}\`), then re-run \`mma mcp install ${clientId}\`.`,
    );
  }

  const homeDir = deps.homeDir ?? os.homedir();
  // Force ONLY this client 'on' for the scope of this call -- never persisted,
  // and never widens what any OTHER client's declared state is.
  const declared: DeclaredClientRoster = { ...deps.config.clients, [clientId]: 'on' };
  const service = buildCliProvisioningService(deps.config, homeDir, { declared });
  const result = await service.provision([clientId]);
  const status = result.byClient[clientId];
  if (!status || status.status === 'failed') {
    throw new McpInstallCliError(
      'provisioning_failed',
      `Provisioning '${clientId}' failed` + (status ? ` (mcpRegistrationStatus=${status.mcpRegistrationStatus}, skillsInstalled=${status.skillsInstalled}).` : '.'),
    );
  }
  return { clientId, status: status.status };
}
