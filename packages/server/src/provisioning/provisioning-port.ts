/**
 * The provisioning port -- the seam between orchestration (service.ts,
 * inventory.ts) and the actual mechanism that touches a client's registration
 * file and skill directory. Production implements this against the filesystem
 * (`real-port.ts`, using `registration-writer.ts` + `owned-files.ts` + the packaged
 * skills under `skills/`); `tests/contract/fixtures/provisioning-fixture.ts`
 * implements it in memory so orchestration (markers, rollback, reference counting,
 * recovery) can be exercised without touching a real disk or a real client's config
 * file.
 */
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import type { ClientCapability } from './capability-registry.js';
import type { RegistrationFingerprint, RegistrationSnapshot } from './marker-store.js';

/** Outcome of a single registration/skill mutation the port performed. */
export interface PortActionResult {
  ok: boolean;
  /** Present when `ok` is false -- surfaced in failure messages/notes. */
  error?: string;
}

/** A registration mutation additionally reports what it left on disk, so the
 *  marker can record a fingerprint to detect later third-party edits before any
 *  restore writes over them. */
export interface RegistrationMutationResult extends PortActionResult {
  /** The file as this mutation left it. Absent when the mutation failed. */
  fingerprint?: RegistrationFingerprint;
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
  writeRegistration(clientId: ClientId, capability: ClientCapability): Promise<RegistrationMutationResult>;
  /** Overwrite the registration file with the EXACT prior bytes (or delete it
   *  when the snapshot recorded nothing existed) -- a literal restore, not a
   *  re-run of the normal idempotent installer. Only safe once
   *  `isRegistrationReachable` has proven the file is still exactly what this
   *  operation left there. */
  restoreRegistration(clientId: ClientId, capability: ClientCapability, snapshot: RegistrationSnapshot): Promise<PortActionResult>;
  /** Remove this client's registration entry entirely (used for an 'off'
   *  operation). Ownership-checked; a foreign entry is left untouched and this
   *  reports failure rather than silently no-op'ing past it. */
  removeRegistration(clientId: ClientId, capability: ClientCapability): Promise<RegistrationMutationResult>;
  /** Whether the path a registration mutation would target is currently
   *  writable, its content is still consistent with what a marker recorded as
   *  the starting point, AND -- when `postMutation` is recorded -- the file is
   *  still byte-for-byte what this operation left there. That last check is what
   *  stops a whole-file restore from discarding an edit the user made to their
   *  own MCP config after the crash that stranded the marker. */
  isRegistrationReachable(
    clientId: ClientId,
    capability: ClientCapability,
    snapshot: RegistrationSnapshot,
    postMutation: RegistrationFingerprint | null,
  ): boolean;
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
   *  whatever this operation partially wrote (nothing existed before).
   *  Must prove the backup still hashes to `expectedDigest` BEFORE removing
   *  anything live: a backup that has gone missing, or been emptied, or lost an
   *  entry is a reason to keep the current content, never a reason to end up
   *  with neither copy. */
  restoreSkills(
    clientId: ClientId,
    capability: ClientCapability,
    backupPath: string | null,
    expectedDigest: string | null,
  ): Promise<PortActionResult>;
  /** Delete a backup taken by `backupSkills` once it can no longer be needed --
   *  the operation reached its terminal phase, or the restore it existed for has
   *  already succeeded. Best-effort: a backup that cannot be deleted is leaked
   *  disk, not a failed operation, so this reports nothing. */
  discardSkillBackup(backupPath: string): void;
  /** Remove this client's skills, honouring shared-root reference counting.
   *  `enabledPeers` is every OTHER enabled client that reads THIS client's skill
   *  root — not merely every enabled client, which would let any unrelated
   *  client block this one's removal. Non-empty means the root is still needed,
   *  so removal is a no-op rather than a deletion. */
  removeSkills(clientId: ClientId, capability: ClientCapability, enabledPeers: ReadonlySet<ClientId>): Promise<PortActionResult>;
  /** Names of packaged skills currently installed (ownership-proven) for this
   *  client. Read-only. */
  installedSkillNames(clientId: ClientId, capability: ClientCapability): string[];
  /**
   * Whether the skill root a mutation would target is currently writable and
   * everything installed under it is still ownership-provable -- the
   * reachability precondition for recovery.
   *
   * Deliberately NOT a digest comparison against the marker's recorded starting
   * point. A crash during `installSkills` leaves the root legitimately different
   * from that starting point (that is the situation recovery exists for), so
   * gating on the digest would refuse precisely when restoring matters most. The
   * ownership proof is what makes the restore safe; the recorded digest earns its
   * keep verifying the BACKUP instead, in `restoreSkills`.
   */
  isSkillsReachable(clientId: ClientId, capability: ClientCapability): boolean;
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
