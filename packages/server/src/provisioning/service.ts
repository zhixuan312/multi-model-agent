/**
 * Atomic client provisioning orchestration.
 *
 * Turning a client 'on' must produce its recognised registration AND its
 * complete applicable skills, or NEITHER -- never a half state a user has to
 * notice and repair by hand. This module is the ONE place that sequences a
 * mutation through a durable marker (`marker-store.ts`) so an interruption
 * (crash, SIGKILL, power loss) leaves enough on disk to safely resolve on the
 * next provisioning run or at daemon start, rather than a silent half state.
 *
 * `createProvisioningService(deps)` is the production entry point -- callers
 * supply a `ProvisioningPort` (see `provisioning-port.ts`) that actually
 * touches a client's registration file and skill directory; `real-port.ts`
 * implements that against the filesystem.
 *
 * The in-memory fake port that exercises this orchestration without a real disk
 * lives in `tests/contract/fixtures/provisioning-fixture.ts`. It used to live at the
 * bottom of THIS file, attached to the production export as
 * `createProvisioningService.testFixture` — roughly 320 lines of test-only code that
 * compiled into `dist/` and shipped to every npm consumer.
 */
import { createHash } from 'node:crypto';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_CAPABILITIES, type ClientCapability } from './capability-registry.js';
import { resolveEffectiveRoster, type DeclaredClientRoster } from './roster.js';
import {
  clearMarker,
  listMarkedClients,
  readMarker,
  writeMarker,
  type ProvisioningMarker,
  type ProvisioningPhase,
  type RegistrationFingerprint,
  type RegistrationSnapshot,
} from './marker-store.js';
import { computeClientStatus, getClientInventory, type ClientInventoryRecord } from './inventory.js';
import { withProvisioningLock, type AcquireLockOptions } from './provisioning-lock.js';
import type { ClientProvisioningStatus, ProvisioningPort, RegistrationMutationResult } from './provisioning-port.js';

export interface ProvisioningServiceDeps {
  stateDir: string;
  port: ProvisioningPort;
  declared: DeclaredClientRoster | undefined;
  detected: ReadonlySet<ClientId>;
  capabilities?: readonly ClientCapability[];
  /** Re-read the declared roster from its durable source. `declared` is a
   *  snapshot taken when this process started; another process may have changed
   *  the declaration since, and after waiting on the provisioning lock that is
   *  not a hypothetical — waiting is exactly when it happens. Defaults to the
   *  snapshot for callers with no durable source to re-read (tests, and any
   *  entry point invoked without a config file). */
  readDeclared?: () => DeclaredClientRoster | undefined;
  /** Test seam for the cross-process lock's timing. */
  lockOptions?: AcquireLockOptions;
  /** Test-only: called immediately after each marker phase is durably
   *  written. Throwing simulates a crash at exactly that point. */
  onPhaseWritten?: (clientId: ClientId, phase: ProvisioningPhase) => void;
}

export interface RecoveryReport {
  clientId: ClientId;
  resolved: boolean;
  reason?: string;
}

export interface ProvisionRunResult {
  byClient: Partial<Record<ClientId, ClientProvisioningStatus>>;
}

function capabilitiesOf(deps: ProvisioningServiceDeps): readonly ClientCapability[] {
  return deps.capabilities ?? CLIENT_CAPABILITIES;
}

function capabilityFor(deps: ProvisioningServiceDeps, clientId: ClientId): ClientCapability {
  const capability = capabilitiesOf(deps).find((candidate) => candidate.id === clientId);
  if (!capability) throw new Error(`No capability registry row for client '${clientId}'.`);
  return capability;
}

function inventoryDeps(deps: ProvisioningServiceDeps) {
  return { stateDir: deps.stateDir, port: deps.port, declared: deps.declared, detected: deps.detected, capabilities: deps.capabilities };
}

/**
 * Clients that are effectively 'on' AND read the SAME skill root as
 * `capability` -- the reference count that decides whether removing this
 * client's skills would strip a root somebody else still consumes.
 *
 * The root comparison is the whole point. Counting every enabled client instead
 * means `mma disable --target=claude-code` silently leaves `~/.claude/skills` in
 * place whenever, say, codex happens to be enabled — two clients with entirely
 * separate roots, one blocking the other's removal. Only cursor, vscode and
 * opencode actually share a root (`~/.agents/skills`); for everyone else this
 * set is always empty and removal proceeds.
 *
 * The roster is re-read rather than taken from `deps.declared`. Getting it wrong
 * in the stale direction is destructive, not conservative: believing a sibling is
 * 'off' when another process just turned it 'on' removes the root that sibling
 * now needs. The opposite staleness merely leaves skills in place.
 */
function enabledRootSharers(deps: ProvisioningServiceDeps, capability: ClientCapability): Set<ClientId> {
  if (!capability.skillRoot) return new Set();
  const declared = deps.readDeclared ? deps.readDeclared() : deps.declared;
  const roster = resolveEffectiveRoster(declared, deps.detected);
  const byId = new Map(capabilitiesOf(deps).map((c) => [c.id, c] as const));
  return new Set(
    roster
      .filter((entry) => entry.effectiveState === 'on'
        && entry.clientId !== capability.id
        && byId.get(entry.clientId)?.skillRoot === capability.skillRoot)
      .map((entry) => entry.clientId),
  );
}

function toSnapshot(read: { path: string; existed: boolean; bytes: Buffer | null }): RegistrationSnapshot {
  return { path: read.path, existed: read.existed, bytesBase64: read.bytes ? read.bytes.toString('base64') : null };
}

/**
 * The fingerprint of a snapshot -- i.e. what the registration file was before this
 * operation touched anything.
 *
 * A marker at phase 'started' needs this, not `null`. `null` means "no drift check
 * available", and reachability then falls back to an ownership-shape test that
 * inspects only the `mma` entry — so a user edit elsewhere in the file gets
 * silently discarded by the whole-file restore. Recording the pre-mutation
 * fingerprint closes that: at 'started' the file must still be untouched for a
 * restore to be provably safe. If it is not — including the narrow case where the
 * registration write landed but the phase transition did not — the marker is
 * unresolved and reported, which is the honest answer, because at that point
 * nothing on disk distinguishes our own write from somebody else's edit.
 */
function fingerprintOfSnapshot(snapshot: RegistrationSnapshot): RegistrationFingerprint {
  if (!snapshot.existed || snapshot.bytesBase64 === null) return { existed: false, sha256: null };
  return { existed: true, sha256: createHash('sha256').update(Buffer.from(snapshot.bytesBase64, 'base64')).digest('hex') };
}

function emitPhase(deps: ProvisioningServiceDeps, clientId: ClientId, phase: ProvisioningPhase): void {
  deps.onPhaseWritten?.(clientId, phase);
}

/**
 * The last phase an operation writes before clearing its marker.
 *
 * A marker recording THIS phase did not fail: every mutation the operation
 * intended succeeded, and only the marker-clear step was lost. Recovery must
 * finish that step rather than undo the work -- see {@link resolvePending}.
 */
function terminalPhaseOf(capability: ClientCapability): ProvisioningPhase {
  return capability.skillPathStrategy === 'none' ? 'registered' : 'skills-written';
}

/**
 * Clear a client's marker and, only if that succeeded, drop the skill backup the
 * marker referenced.
 *
 * The order is the point. The marker is the only thing that knows where the
 * backup is; while it is still on disk, recovery may yet need to restore from
 * that backup. Deleting the backup first and then failing to clear the marker
 * would leave a marker pointing at nothing. Discarding is best-effort by design:
 * a backup left behind is disk to reclaim, never a failed operation.
 */
function clearMarkerAndBackup(deps: ProvisioningServiceDeps, clientId: ClientId, backupPath: string | null): boolean {
  if (!clearMarker(deps.stateDir, clientId)) return false;
  if (backupPath) deps.port.discardSkillBackup(backupPath);
  return true;
}

/**
 * Restore a client to the state recorded by `marker`, gated by the
 * reachability predicate for each phase the marker's operation actually
 * reached. Shared by both inline rollback (a failure mid-`runOn`/`runOff`) and
 * out-of-band recovery (`resolvePending`) -- ONE restore implementation.
 */
async function restoreFromMarker(
  deps: ProvisioningServiceDeps,
  capability: ClientCapability,
  marker: ProvisioningMarker,
): Promise<{ ok: boolean; reason?: string }> {
  const clientId = capability.id;

  if (!deps.port.isRegistrationReachable(clientId, capability, marker.priorRegistration, marker.postRegistration)) {
    return {
      ok: false,
      reason: 'registration path is not this client\'s, is not writable, or its content is no longer what this '
        + 'operation left there (restoring the snapshot over it would discard whatever changed it)',
    };
  }
  const touchedSkills = capability.skillPathStrategy !== 'none' && (marker.phase === 'registered' || marker.phase === 'skills-written');
  if (touchedSkills) {
    if (!deps.port.isSkillsReachable(clientId, capability)) {
      return { ok: false, reason: 'skill root is not writable, or something under it is no longer ownership-provable' };
    }
  }

  // One branch, not two. A snapshot is always captured before either operation
  // mutates anything, and "there was no file" is `existed: false` inside it --
  // which restoreRegistration handles by removing what this operation wrote. The
  // separate 'off' removal path this replaced could never be reached.
  const result = await deps.port.restoreRegistration(clientId, capability, marker.priorRegistration);
  if (!result.ok) return { ok: false, reason: result.error ?? 'registration restore failed' };
  if (touchedSkills) {
    const result = await deps.port.restoreSkills(clientId, capability, marker.priorSkillBackup, marker.priorSkillDigest);
    if (!result.ok) return { ok: false, reason: result.error ?? 'skills restore failed' };
  }
  return { ok: true };
}

/**
 * Resolve any marker left on disk for `capability` -- the shared recovery
 * primitive run both at the top of every `provision()` call (so a fresh
 * operation never stacks on top of an unresolved one) and for every marked
 * client at daemon start.
 */
async function resolvePending(deps: ProvisioningServiceDeps, capability: ClientCapability): Promise<RecoveryReport> {
  const clientId = capability.id;
  const read = readMarker(deps.stateDir, clientId);
  if (read.status === 'absent') return { clientId, resolved: true };
  if (read.status === 'corrupt') {
    // Reported, never silently ignored -- but with no trustworthy data to act
    // on, the only safe move is to leave it and let an operator investigate.
    return { clientId, resolved: false, reason: 'marker is unparseable/corrupt' };
  }

  if (read.marker.phase === terminalPhaseOf(capability)) {
    // The operation succeeded end to end and only failed to clear its own
    // marker. Rolling back here would revert a client that is correctly
    // provisioned right now -- an unresolved marker is not evidence of a failed
    // mutation, only of an unfinished bookkeeping step. Finish that step.
    if (!clearMarkerAndBackup(deps, clientId, read.marker.priorSkillBackup)) {
      return { clientId, resolved: false, reason: "the completed operation's marker could not be cleared" };
    }
    return { clientId, resolved: true };
  }

  const outcome = await restoreFromMarker(deps, capability, read.marker);
  if (!outcome.ok) return { clientId, resolved: false, reason: outcome.reason };
  if (!clearMarkerAndBackup(deps, clientId, read.marker.priorSkillBackup)) {
    return { clientId, resolved: false, reason: 'recovery restored prior state but could not clear its marker' };
  }
  return { clientId, resolved: true };
}

/** Resolves every marker currently on disk -- run at daemon start (before any
 *  inventory read is considered healthy) and available for on-demand use. */
async function recoverAll(deps: ProvisioningServiceDeps): Promise<RecoveryReport[]> {
  const reports: RecoveryReport[] = [];
  for (const clientId of listMarkedClients(deps.stateDir)) {
    reports.push(await resolvePending(deps, capabilityFor(deps, clientId)));
  }
  return reports;
}

/** Fresh registration + skill snapshot captured before ANY mutation this
 *  operation performs -- the restore source for both inline rollback and
 *  later recovery. */
async function captureStartingPoint(
  deps: ProvisioningServiceDeps,
  capability: ClientCapability,
): Promise<{ priorRegistration: RegistrationSnapshot; priorSkillBackup: string | null; priorSkillDigest: string | null }> {
  const clientId = capability.id;
  const priorRegistration = toSnapshot(deps.port.readRegistration(clientId, capability));
  if (capability.skillPathStrategy === 'none') {
    return { priorRegistration, priorSkillBackup: null, priorSkillDigest: null };
  }
  const backup = await deps.port.backupSkills(clientId, capability);
  return { priorRegistration, priorSkillBackup: backup.backupPath, priorSkillDigest: backup.digest };
}

async function runOn(deps: ProvisioningServiceDeps, capability: ClientCapability): Promise<ClientProvisioningStatus> {
  const clientId = capability.id;
  const start = await captureStartingPoint(deps, capability);

  const baseMarker: ProvisioningMarker = {
    clientId,
    operation: 'on',
    intendedState: 'on',
    phase: 'started',
    priorRegistration: start.priorRegistration,
    postRegistration: fingerprintOfSnapshot(start.priorRegistration),
    priorSkillBackup: start.priorSkillBackup,
    priorSkillDigest: start.priorSkillDigest,
    startedAt: Date.now(),
  };
  writeMarker(deps.stateDir, baseMarker);
  emitPhase(deps, clientId, 'started');

  const registered = await deps.port.writeRegistration(clientId, capability);
  if (!registered.ok) {
    // Nothing besides the registration write was attempted, and an
    // ownership-safe writer never partially mutates on failure -- the file is
    // already exactly its prior state, so there is nothing to roll back.
    clearMarkerAndBackup(deps, clientId, start.priorSkillBackup);
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }

  const registeredMarker: ProvisioningMarker = {
    ...baseMarker,
    phase: 'registered',
    postRegistration: registered.fingerprint ?? null,
  };
  writeMarker(deps.stateDir, registeredMarker);
  emitPhase(deps, clientId, 'registered');

  if (capability.skillPathStrategy === 'none') {
    // Registration alone is a complete, successful install for a 'none'
    // client -- never left permanently marked waiting for a skills phase
    // that will never come.
    if (!clearMarkerAndBackup(deps, clientId, start.priorSkillBackup)) {
      return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
    }
    return { clientId, status: 'provisioned', skillsInstalled: false, mcpRegistrationStatus: 'registered' };
  }

  const skills = await deps.port.installSkills(clientId, capability);
  if (!skills.ok) {
    const rollback = await restoreFromMarker(deps, capability, registeredMarker);
    if (rollback.ok) {
      clearMarkerAndBackup(deps, clientId, start.priorSkillBackup);
      // The registration this attempt would have confirmed was rolled back
      // along with the skills that failed -- this attempt achieved neither,
      // even though the file on disk was restored to its (possibly still
      // valid) prior bytes rather than merely deleted.
      return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'absent' };
    }
    // Could not safely undo -- leave the marker for the next provisioning
    // run or daemon-start recovery to resolve; never report success.
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }

  // Built from registeredMarker, not baseMarker: the registration fingerprint
  // recorded one phase ago must survive into the terminal phase, or a recovery
  // reading this marker would have no drift check to gate a restore on.
  const skillsWrittenMarker: ProvisioningMarker = { ...registeredMarker, phase: 'skills-written' };
  writeMarker(deps.stateDir, skillsWrittenMarker);
  emitPhase(deps, clientId, 'skills-written');

  if (!clearMarkerAndBackup(deps, clientId, start.priorSkillBackup)) {
    return { clientId, status: 'failed', skillsInstalled: true, mcpRegistrationStatus: 'failed' };
  }
  return { clientId, status: 'provisioned', skillsInstalled: true, mcpRegistrationStatus: 'registered' };
}

async function runOff(deps: ProvisioningServiceDeps, capability: ClientCapability): Promise<ClientProvisioningStatus> {
  const clientId = capability.id;
  const start = await captureStartingPoint(deps, capability);

  const marker: ProvisioningMarker = {
    clientId,
    operation: 'off',
    intendedState: 'off',
    phase: 'started',
    priorRegistration: start.priorRegistration,
    postRegistration: fingerprintOfSnapshot(start.priorRegistration),
    priorSkillBackup: start.priorSkillBackup,
    priorSkillDigest: start.priorSkillDigest,
    startedAt: Date.now(),
  };
  writeMarker(deps.stateDir, marker);
  emitPhase(deps, clientId, 'started');

  const removedRegistration = await deps.port.removeRegistration(clientId, capability);
  if (!removedRegistration.ok) {
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }

  // Reuse the durable phase sequence for the reverse operation: once the
  // registration has been removed, recovery must know that the next step can
  // touch the skill root and therefore that both assets need restoring after
  // an interruption.  Without this transition a crash after skill removal
  // would leave a `started` marker that restored only the registration.
  const registrationRemovedMarker: ProvisioningMarker = {
    ...marker,
    phase: 'registered',
    postRegistration: removedRegistration.fingerprint ?? null,
  };
  writeMarker(deps.stateDir, registrationRemovedMarker);
  emitPhase(deps, clientId, 'registered');

  if (capability.skillPathStrategy === 'none') {
    if (!clearMarkerAndBackup(deps, clientId, start.priorSkillBackup)) {
      return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
    }
    return { clientId, status: 'removed', skillsInstalled: false, mcpRegistrationStatus: 'absent' };
  }

  const removedSkills = await deps.port.removeSkills(clientId, capability, enabledRootSharers(deps, capability));
  if (!removedSkills.ok) {
    // Registration is already gone but skills could not be removed --
    // restore the registration rather than leave the client half-off.
    const rollback = await restoreFromMarker(deps, capability, registrationRemovedMarker);
    if (!rollback.ok) {
      return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
    }
    clearMarkerAndBackup(deps, clientId, start.priorSkillBackup);
    return { clientId, status: 'failed', skillsInstalled: true, mcpRegistrationStatus: 'registered' };
  }

  // Built from registrationRemovedMarker so the post-removal fingerprint carries
  // into the terminal phase -- same reason as runOn's skills-written marker.
  const skillsRemovedMarker: ProvisioningMarker = { ...registrationRemovedMarker, phase: 'skills-written' };
  writeMarker(deps.stateDir, skillsRemovedMarker);
  emitPhase(deps, clientId, 'skills-written');

  if (!clearMarkerAndBackup(deps, clientId, start.priorSkillBackup)) {
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }
  return { clientId, status: 'removed', skillsInstalled: false, mcpRegistrationStatus: 'absent' };
}

async function provisionOne(deps: ProvisioningServiceDeps, capability: ClientCapability): Promise<ClientProvisioningStatus> {
  const clientId = capability.id;
  const pending = await resolvePending(deps, capability);
  if (!pending.resolved) {
    return { clientId, status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' };
  }

  const roster = resolveEffectiveRoster(deps.declared, deps.detected);
  const entry = roster.find((candidate) => candidate.clientId === clientId);
  const effectiveState = entry?.effectiveState ?? 'off';

  if (effectiveState === 'suggested') {
    return computeClientStatus(inventoryDeps(deps), capability, 'suggested');
  }
  if (effectiveState === 'off') {
    const currentlyPresent = deps.port.isRegistrationPresent(clientId, capability)
      || (capability.skillPathStrategy !== 'none' && deps.port.installedSkillNames(clientId, capability).length > 0);
    if (!currentlyPresent) {
      return computeClientStatus(inventoryDeps(deps), capability, 'off');
    }
    return runOff(deps, capability);
  }
  return runOn(deps, capability);
}

async function provisionMany(deps: ProvisioningServiceDeps, ids: readonly ClientId[]): Promise<ProvisionRunResult> {
  const byClient: Partial<Record<ClientId, ClientProvisioningStatus>> = {};
  for (const id of ids) {
    const capability = capabilityFor(deps, id);
    byClient[id] = await provisionOne(deps, capability);
  }
  return { byClient };
}

export interface ProvisioningService {
  provision(ids: ClientId[]): Promise<ProvisionRunResult>;
  provisionAll(): Promise<ProvisionRunResult>;
  recoverOnStartup(): Promise<RecoveryReport[]>;
  inventory(): Promise<ClientInventoryRecord[]>;
}

function buildService(deps: ProvisioningServiceDeps): ProvisioningService {
  // Every MUTATING entry point runs under the cross-process lock; `inventory`
  // does not, because a read that blocks on somebody else's write would make
  // `mma clients` hang behind an npm postinstall for no benefit — it reports a
  // moment in time either way.
  const locked = <T>(fn: () => Promise<T>): Promise<T> =>
    withProvisioningLock(deps.stateDir, fn, deps.lockOptions);
  return {
    provision: (ids) => locked(() => provisionMany(deps, ids)),
    provisionAll: () => locked(() => provisionMany(deps, capabilitiesOf(deps).map((c) => c.id))),
    recoverOnStartup: () => locked(() => recoverAll(deps)),
    inventory: () => getClientInventory(inventoryDeps(deps)),
  };
}

/** Production entry point. `real-port.ts` supplies the filesystem-backed
 *  `ProvisioningPort`; callers (the daemon boot sequence, the `mma clients` /
 *  `mma mcp install` CLI surface) provide the rest. */
export const createProvisioningService = buildService;
