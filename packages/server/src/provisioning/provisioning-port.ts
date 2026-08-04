/**
 * The provisioning port -- the seam between orchestration (service.ts,
 * inventory.ts) and the actual mechanism that touches a client's registration
 * file and skill directory. Real production code implements this against the
 * filesystem (`real-port.ts`, using `registration-writer.ts` + `owned-files.ts` +
 * the packaged skills under `skills/`); `service.ts`'s `createProvisioningService
 * .testFixture()` implements it in memory so orchestration (markers, rollback,
 * reference counting, recovery) can be exercised without touching a real disk or
 * a real client's config file.
 */
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import type { ClientCapability } from './capability-registry.js';
import type { RegistrationSnapshot } from './marker-store.js';

/** Outcome of a single registration/skill mutation the port performed. */
export interface PortActionResult {
  ok: boolean;
  /** Present when `ok` is false -- surfaced in failure messages/notes. */
  error?: string;
}

/** A snapshot of what a client's skill root held for this client BEFORE the
 *  current operation mutates it -- taken immediately before install/remove so it
 *  reflects exactly what must be restored on rollback. */
export interface SkillBackupResult {
  /** Absolute path to a real, restorable copy of the prior skill directories, or
   *  `null` when nothing was installed there yet (a fresh install has nothing to
   *  back up). Never a placeholder: if a real backup cannot be produced for
   *  content that DOES exist, the port must report failure rather than return
   *  `null` here. */
  backupPath: string | null;
  /** Digest of the backed-up content, or `null` alongside a `null` backupPath. */
  digest: string | null;
}

export interface ProvisioningPort {
  /** Absolute path a registration write/remove/restore would target for this
   *  client, plus whatever currently exists there. Read-only. */
  readRegistration(clientId: ClientId, capability: ClientCapability): { path: string; existed: boolean; bytes: Buffer | null };
  /** Idempotently install this client's recognised registration entry. */
  writeRegistration(clientId: ClientId, capability: ClientCapability): Promise<PortActionResult>;
  /** Overwrite the registration file with the EXACT prior bytes (or delete it
   *  when the snapshot recorded nothing existed) -- a literal restore, not a
   *  re-run of the normal idempotent installer. */
  restoreRegistration(clientId: ClientId, capability: ClientCapability, snapshot: RegistrationSnapshot): Promise<PortActionResult>;
  /** Remove this client's registration entry entirely (used for an 'off'
   *  operation). Ownership-checked; a foreign entry is left untouched and this
   *  reports failure rather than silently no-op'ing past it. */
  removeRegistration(clientId: ClientId, capability: ClientCapability): Promise<PortActionResult>;
  /** Whether the path a registration mutation would target is currently
   *  writable AND its content is still consistent with what a marker recorded
   *  as the starting point -- the reachability precondition for recovery. */
  isRegistrationReachable(clientId: ClientId, capability: ClientCapability, snapshot: RegistrationSnapshot): boolean;
  /** Whether an ownership-proven MMA registration entry is currently present
   *  for this client -- read-only, used by inventory. Distinct from
   *  `readRegistration`'s raw byte snapshot: this is the ownership-verified
   *  answer, not merely "a file exists at this path". */
  isRegistrationPresent(clientId: ClientId, capability: ClientCapability): boolean;

  /** Every packaged skill name provisioning installs, in a stable order. */
  packagedSkillNames(): string[];
  /** Snapshot whatever is currently installed for this client's skill root
   *  BEFORE this operation mutates it. */
  backupSkills(clientId: ClientId, capability: ClientCapability): Promise<SkillBackupResult>;
  /** Render and install every packaged skill for this client via the
   *  ownership-safe primitives -- refuses (fails) rather than clobbering
   *  unowned/modified content. */
  installSkills(clientId: ClientId, capability: ClientCapability): Promise<PortActionResult>;
  /** Restore a client's skill root to exactly the backup taken by
   *  `backupSkills` -- `backupPath: null` means restoring means removing
   *  whatever this operation partially wrote (nothing existed before). */
  restoreSkills(clientId: ClientId, capability: ClientCapability, backupPath: string | null): Promise<PortActionResult>;
  /** Remove this client's skills, honouring shared-root reference counting:
   *  `enabledPeers` is every OTHER currently-enabled client sharing the same
   *  root; when non-empty for a shared root, this is a no-op (the root is
   *  still needed) rather than a removal. */
  removeSkills(clientId: ClientId, capability: ClientCapability, enabledPeers: ReadonlySet<ClientId>): Promise<PortActionResult>;
  /** Names of packaged skills currently installed (ownership-proven) for this
   *  client. Read-only. */
  installedSkillNames(clientId: ClientId, capability: ClientCapability): string[];
  /** Whether the skill root a mutation would target is currently writable AND
   *  its observed ownership state matches what a marker recorded as the
   *  starting point -- the reachability precondition for recovery. */
  isSkillsReachable(clientId: ClientId, capability: ClientCapability, priorDigest: string | null): boolean;
}

/** The per-client status shape shared by a provisioning outcome (what THIS
 *  call did for this client) and an inventory record (what is currently true
 *  for this client) -- see service.ts / inventory.ts for how each is computed. */
export interface ClientProvisioningStatus {
  clientId: ClientId;
  status: 'provisioned' | 'removed' | 'suggested' | 'off' | 'failed';
  skillsInstalled: boolean;
  mcpRegistrationStatus: 'registered' | 'absent' | 'failed';
}
