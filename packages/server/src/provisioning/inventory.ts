/**
 * Client inventory -- the truthful, read-only "what is actually provisioned
 * right now" answer, one record per canonical client in `CLIENT_IDS` order.
 * Consumed by `GET /health`, `cli/serve.ts`'s boot drift warning, and (once I-8
 * lands) `mma clients`.
 *
 * A client with an unresolved marker ALWAYS reports `failed` here, regardless
 * of what its files happen to contain -- an interrupted operation proves
 * nothing about the client's current usability until recovery has resolved it.
 * `'provisioned'` requires BOTH an ownership-proven registration AND every
 * packaged skill present with a matching ownership digest for strategies that
 * have skills at all; a non-empty skill root proves nothing by itself.
 */
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_CAPABILITIES, type ClientCapability } from './capability-registry.js';
import { resolveEffectiveRoster, type DeclaredClientRoster } from './roster.js';
import { readMarker } from './marker-store.js';
import type { ClientProvisioningStatus, ProvisioningPort } from './provisioning-port.js';

export type ClientInventoryRecord = ClientProvisioningStatus;

export interface InventoryDeps {
  stateDir: string;
  port: ProvisioningPort;
  declared: DeclaredClientRoster | undefined;
  detected: ReadonlySet<ClientId>;
  capabilities?: readonly ClientCapability[];
}

/** Read-only per-client status computation shared by `getClientInventory` and
 *  `service.ts` (for clients a provisioning call did not itself mutate this
 *  round -- 'suggested'/'off' entries, and any sibling untouched by a scoped
 *  `provision([...])` call). */
export function computeClientStatus(deps: InventoryDeps, capability: ClientCapability, effectiveState: 'on' | 'off' | 'suggested'): ClientInventoryRecord {
  const clientId = capability.id;
  const markerRead = readMarker(deps.stateDir, clientId);
  if (markerRead.status !== 'absent') {
    // An unresolved (or corrupt/unparseable) marker means the last operation
    // never reached a trustworthy terminal state -- report failed regardless
    // of what the files happen to contain until recovery resolves it.
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }

  if (effectiveState === 'suggested') {
    return { clientId, status: 'suggested', skillsInstalled: false, mcpRegistrationStatus: 'absent' };
  }
  if (effectiveState === 'off') {
    return { clientId, status: 'off', skillsInstalled: false, mcpRegistrationStatus: 'absent' };
  }

  const registered = deps.port.isRegistrationPresent(clientId, capability);
  let skillsInstalled = false;
  let skillsOk = capability.skillPathStrategy === 'none';
  if (capability.skillPathStrategy !== 'none') {
    const packaged = deps.port.packagedSkillNames();
    const installed = new Set(deps.port.installedSkillNames(clientId, capability));
    skillsInstalled = packaged.length > 0 && packaged.every((name) => installed.has(name));
    skillsOk = skillsInstalled;
  }

  return {
    clientId,
    status: registered && skillsOk ? 'provisioned' : 'failed',
    skillsInstalled,
    mcpRegistrationStatus: registered ? 'registered' : 'absent',
  };
}

/** The full eight-record inventory, one per `ClientId` in `CLIENT_IDS` order. */
export async function getClientInventory(deps: InventoryDeps): Promise<ClientInventoryRecord[]> {
  const capabilities = deps.capabilities ?? CLIENT_CAPABILITIES;
  const roster = resolveEffectiveRoster(deps.declared, deps.detected);
  const records: ClientInventoryRecord[] = [];
  for (const entry of roster) {
    const capability = capabilities.find((candidate) => candidate.id === entry.clientId);
    if (!capability) continue;
    const effectiveState = entry.effectiveState === 'suggested' ? 'suggested' : entry.effectiveState;
    records.push(computeClientStatus(deps, capability, effectiveState));
  }
  return records;
}
