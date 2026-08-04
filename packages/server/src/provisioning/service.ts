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
 * implements that against the filesystem. `createProvisioningService
 * .testFixture()` builds the SAME orchestration wired to an in-memory fake
 * port, so markers/rollback/reference-counting/recovery can be exercised
 * without touching a real disk or a real client's config file.
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
import type { ClientProvisioningStatus, ProvisioningPort, RegistrationMutationResult } from './provisioning-port.js';

/** Thrown when a test's `interruptAfter` hook fires -- simulates the process
 *  dying immediately after a marker phase was durably written. The marker on
 *  disk is left exactly as written; nothing further runs for this client. */
class InterruptedProvisioningError extends Error {
  readonly code = 'interrupted' as const;
  readonly clientId: ClientId;
  readonly phase: ProvisioningPhase;
  constructor(clientId: ClientId, phase: ProvisioningPhase) {
    super(`provisioning for '${clientId}' was interrupted immediately after phase '${phase}' (simulated)`);
    this.name = 'InterruptedProvisioningError';
    this.clientId = clientId;
    this.phase = phase;
  }
}

export interface ProvisioningServiceDeps {
  stateDir: string;
  port: ProvisioningPort;
  declared: DeclaredClientRoster | undefined;
  detected: ReadonlySet<ClientId>;
  capabilities?: readonly ClientCapability[];
  now?: () => number;
  /** Test-only: called immediately after each marker phase is durably
   *  written. Throwing simulates a crash at exactly that point. */
  onPhaseWritten?: (clientId: ClientId, phase: ProvisioningPhase) => void;
}

interface RecoveryReport {
  clientId: ClientId;
  resolved: boolean;
  reason?: string;
}

interface ProvisionRunResult {
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

/** Every client currently effectively 'on' -- used for shared-root reference
 *  counting when removing skills for an 'off' transition. */
function enabledClientIds(deps: ProvisioningServiceDeps): Set<ClientId> {
  const roster = resolveEffectiveRoster(deps.declared, deps.detected);
  return new Set(roster.filter((entry) => entry.effectiveState === 'on').map((entry) => entry.clientId));
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
    startedAt: (deps.now ?? Date.now)(),
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
    startedAt: (deps.now ?? Date.now)(),
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

  const peers = enabledClientIds(deps);
  peers.delete(clientId);
  const removedSkills = await deps.port.removeSkills(clientId, capability, peers);
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
  return {
    provision: (ids) => provisionMany(deps, ids),
    provisionAll: () => provisionMany(deps, capabilitiesOf(deps).map((c) => c.id)),
    recoverOnStartup: () => recoverAll(deps),
    inventory: () => getClientInventory(inventoryDeps(deps)),
  };
}

interface CreateProvisioningService {
  (deps: ProvisioningServiceDeps): ProvisioningService;
  testFixture(options: TestFixtureOptions): ProvisioningTestFixture;
}

/** Production entry point. `real-port.ts` supplies the filesystem-backed
 *  `ProvisioningPort`; callers (the daemon boot sequence, the `mma clients` /
 *  `mma mcp install` CLI surface) provide the rest. */
export const createProvisioningService = buildService as CreateProvisioningService;

// ── Test fixture ────────────────────────────────────────────────────────────
//
// Everything below builds an in-memory `ProvisioningPort` so the orchestration
// above (markers, rollback, shared-root reference counting, recovery) can be
// exercised deterministically without a real disk or a real client's config
// file. Production behaviour lives entirely above this line; nothing here is
// reachable from non-test code.

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSkillDigest } from './owned-files.js';
import { SUPPORTED_SKILLS } from '../skill-install/discover.js';

interface TestFixtureOptions {
  clients?: Partial<Record<ClientId, 'on' | 'off'>>;
  failRegistrationFor?: Set<ClientId>;
  detected?: ReadonlySet<ClientId>;
  capabilities?: readonly ClientCapability[];
}

interface ProvisioningTestFixture {
  provision(ids: ClientId[]): Promise<ProvisionRunResult>;
  provisionAll(): Promise<ProvisionRunResult>;
  recoverOnStartup(): Promise<RecoveryReport[]>;
  inventory(): Promise<ClientInventoryRecord[]>;
  installedSkillNames(clientId: ClientId): string[];
  packagedSkillNames(): string[];
  readonly failSkillsFor: Set<ClientId>;
  interruptAfter(phase: ProvisioningPhase, clientId: ClientId): void;
  marker(clientId: ClientId): ProvisioningMarker | null;
  registrationEntry(clientId: ClientId): Record<string, unknown> | null;
  phaseHistory(clientId: ClientId): ProvisioningPhase[];
  writeCorruptMarker(clientId: ClientId): void;
  makeUnrestorable(clientId: ClientId): void;
  makeRegistrationUnwritable(clientId: ClientId): void;
  makeSkillsUnwritable(clientId: ClientId): void;
  tamperRegistration(clientId: ClientId): void;
  tamperSkills(clientId: ClientId): void;
  /** Replaces the client's registration bytes as a third party would -- the user
   *  saving their own MCP config while a marker is still pending. */
  editRegistrationOutsideMma(clientId: ClientId, entry: Record<string, unknown>): void;
  /** Deletes the skill backup the client's current marker points at, simulating
   *  a backup that did not survive as long as the marker referencing it. */
  deleteSkillBackup(clientId: ClientId): void;
  /** Every skill-backup directory currently on disk for this fixture. */
  skillBackupDirs(): string[];
  /** Changes the DECLARED roster after construction -- e.g. to simulate a
   *  config edit turning a shared-root client 'off' while a sibling stays
   *  'on', for shared-root reference-counting cases. */
  setClientState(clientId: ClientId, state: 'on' | 'off'): void;
  stateDir: string;
}

class FakeProvisioningPort implements ProvisioningPort {
  private readonly registrations = new Map<ClientId, Buffer | null>();
  private readonly skillRoots = new Map<string, Map<string, Buffer>>();
  private readonly unwritableRegistrationFor = new Set<ClientId>();
  private readonly unwritableSkillsFor = new Set<ClientId>();
  private readonly tamperedRegistrationFor = new Set<ClientId>();
  private readonly tamperedSkillsFor = new Set<ClientId>();
  private readonly restoreFailFor = new Set<ClientId>();
  private readonly stateDir: string;
  readonly failRegistrationFor: Set<ClientId>;
  readonly failSkillsFor = new Set<ClientId>();

  constructor(failRegistrationFor: Set<ClientId>, stateDir: string) {
    this.failRegistrationFor = failRegistrationFor;
    this.stateDir = stateDir;
  }

  /** Same location the real port uses, so a test asserting "no backup was left
   *  behind" is asserting the production layout rather than a fixture-only one. */
  private backupsRoot(): string {
    return join(this.stateDir, 'provisioning', 'skill-backups');
  }

  private path(clientId: ClientId): string {
    return `/fake/home/${clientId}/registration.json`;
  }

  private rootKey(capability: ClientCapability): string {
    return capability.skillRoot ?? `__none__/${capability.id}`;
  }

  private rootMap(capability: ClientCapability): Map<string, Buffer> {
    const key = this.rootKey(capability);
    let map = this.skillRoots.get(key);
    if (!map) { map = new Map(); this.skillRoots.set(key, map); }
    return map;
  }

  readRegistration(clientId: ClientId): { path: string; existed: boolean; bytes: Buffer | null } {
    const bytes = this.registrations.get(clientId) ?? null;
    return { path: this.path(clientId), existed: bytes !== null, bytes };
  }

  private fingerprint(clientId: ClientId): RegistrationFingerprint {
    const bytes = this.registrations.get(clientId) ?? null;
    return bytes === null ? { existed: false, sha256: null } : { existed: true, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async writeRegistration(clientId: ClientId): Promise<RegistrationMutationResult> {
    if (this.failRegistrationFor.has(clientId)) return { ok: false, error: 'simulated registration failure' };
    this.registrations.set(clientId, Buffer.from(JSON.stringify({ mma: { client: clientId, url: 'http://127.0.0.1/mcp' } })));
    return { ok: true, fingerprint: this.fingerprint(clientId) };
  }

  async restoreRegistration(clientId: ClientId, _capability: ClientCapability, snapshot: RegistrationSnapshot): Promise<{ ok: boolean; error?: string }> {
    if (this.restoreFailFor.has(clientId)) return { ok: false, error: 'simulated restore failure' };
    this.registrations.set(clientId, snapshot.existed && snapshot.bytesBase64 ? Buffer.from(snapshot.bytesBase64, 'base64') : null);
    return { ok: true };
  }

  async removeRegistration(clientId: ClientId): Promise<RegistrationMutationResult> {
    this.registrations.set(clientId, null);
    return { ok: true, fingerprint: this.fingerprint(clientId) };
  }

  isRegistrationReachable(
    clientId: ClientId,
    _capability: ClientCapability,
    _snapshot: RegistrationSnapshot,
    postMutation: RegistrationFingerprint | null,
  ): boolean {
    if (this.unwritableRegistrationFor.has(clientId)) return false;
    if (this.tamperedRegistrationFor.has(clientId)) return false;
    // Same drift rule the real port applies: the file must still be exactly
    // what this operation left there for a whole-file restore to be safe.
    if (postMutation !== null) {
      const current = this.fingerprint(clientId);
      if (current.existed !== postMutation.existed || current.sha256 !== postMutation.sha256) return false;
    }
    return true;
  }

  isRegistrationPresent(clientId: ClientId): boolean {
    return (this.registrations.get(clientId) ?? null) !== null;
  }

  packagedSkillNames(): string[] {
    return [...SUPPORTED_SKILLS];
  }

  async backupSkills(clientId: ClientId, capability: ClientCapability): Promise<{ backupPath: string | null; digest: string | null }> {
    if (capability.skillPathStrategy === 'none') return { backupPath: null, digest: null };
    const root = this.rootMap(capability);
    if (root.size === 0) return { backupPath: null, digest: null };
    mkdirSync(this.backupsRoot(), { recursive: true });
    const backupDir = mkdtempSync(join(this.backupsRoot(), `${clientId}-`));
    for (const [name, bytes] of root) {
      const dir = join(backupDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), bytes);
    }
    const rendered = new Map([...root].map(([name, bytes]) => [`${name}/SKILL.md`, bytes] as const));
    return { backupPath: backupDir, digest: computeSkillDigest(rendered) };
  }

  async installSkills(clientId: ClientId, capability: ClientCapability): Promise<{ ok: boolean; error?: string }> {
    if (capability.skillPathStrategy === 'none') return { ok: true };
    if (this.failSkillsFor.has(clientId)) return { ok: false, error: 'simulated skill failure' };
    const root = this.rootMap(capability);
    for (const name of this.packagedSkillNames()) {
      root.set(name, Buffer.from(`content-for:${name}`));
    }
    return { ok: true };
  }

  async restoreSkills(
    clientId: ClientId,
    capability: ClientCapability,
    backupPath: string | null,
    expectedDigest: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    if (capability.skillPathStrategy === 'none') return { ok: true };
    if (this.restoreFailFor.has(clientId)) return { ok: false, error: 'simulated restore failure' };
    const root = this.rootMap(capability);
    // Read and verify the backup FIRST, exactly as the real port does: a backup
    // that has gone missing -- or been emptied -- must leave the live content
    // alone rather than clear it and then discover there is nothing to put back.
    let restored: Array<[string, Buffer]> = [];
    if (backupPath) {
      if (!existsSync(backupPath)) {
        return { ok: false, error: `the skill backup recorded at ${backupPath} no longer exists, so the current content is kept` };
      }
      restored = readdirSync(backupPath).map((name) => [name, readFileSync(join(backupPath, name, 'SKILL.md'))] as [string, Buffer]);
      const digest = computeSkillDigest(new Map(restored.map(([name, bytes]) => [`${name}/SKILL.md`, bytes] as const)));
      if (digest !== expectedDigest) {
        return { ok: false, error: `the skill backup at ${backupPath} no longer matches the digest recorded when it was taken` };
      }
    }
    root.clear();
    for (const [name, bytes] of restored) root.set(name, bytes);
    return { ok: true };
  }

  discardSkillBackup(backupPath: string): void {
    rmSync(backupPath, { recursive: true, force: true });
  }

  async removeSkills(clientId: ClientId, capability: ClientCapability, enabledPeers: ReadonlySet<ClientId>): Promise<{ ok: boolean; error?: string }> {
    if (capability.skillPathStrategy === 'none') return { ok: true };
    if (enabledPeers.size > 0) return { ok: true };
    this.rootMap(capability).clear();
    return { ok: true };
  }

  installedSkillNames(clientId: ClientId, capability: ClientCapability): string[] {
    if (capability.skillPathStrategy === 'none') return [];
    const root = this.rootMap(capability);
    // Canonical packaged order, not raw Map insertion order -- a shared root's
    // map gets rebuilt (in filesystem/readdir order) by restore/rollback, and
    // "installed" should read the same regardless of that internal bookkeeping.
    return this.packagedSkillNames().filter((name) => root.has(name));
  }

  isSkillsReachable(clientId: ClientId, _capability: ClientCapability): boolean {
    if (this.unwritableSkillsFor.has(clientId)) return false;
    if (this.tamperedSkillsFor.has(clientId)) return false;
    return true;
  }

  // ── Test-only controls ────────────────────────────────────────────────
  makeUnrestorable(clientId: ClientId): void { this.restoreFailFor.add(clientId); }
  /** Simulates the user saving their own MCP config after MMA wrote to it --
   *  the case a whole-file restore would silently discard. */
  editRegistrationOutsideMma(clientId: ClientId, entry: Record<string, unknown>): void {
    this.registrations.set(clientId, Buffer.from(JSON.stringify(entry)));
  }
  makeRegistrationUnwritable(clientId: ClientId): void { this.unwritableRegistrationFor.add(clientId); }
  makeSkillsUnwritable(clientId: ClientId): void { this.unwritableSkillsFor.add(clientId); }
  tamperRegistration(clientId: ClientId): void { this.tamperedRegistrationFor.add(clientId); }
  tamperSkills(clientId: ClientId): void { this.tamperedSkillsFor.add(clientId); }
  registrationEntry(clientId: ClientId): Record<string, unknown> | null {
    const bytes = this.registrations.get(clientId) ?? null;
    return bytes ? (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>) : null;
  }
}

function buildTestFixture(options: TestFixtureOptions): ProvisioningTestFixture {
  const stateDir = mkdtempSync(join(tmpdir(), 'mma-provisioning-fixture-'));
  const port = new FakeProvisioningPort(options.failRegistrationFor ?? new Set(), stateDir);
  const declared: DeclaredClientRoster = { ...options.clients };
  const detected = options.detected ?? new Set<ClientId>();
  const capabilities = options.capabilities ?? CLIENT_CAPABILITIES;

  const oneShotInterrupts = new Map<ClientId, ProvisioningPhase>();
  const phaseHistory = new Map<ClientId, ProvisioningPhase[]>();

  const deps: ProvisioningServiceDeps = {
    stateDir,
    port,
    declared,
    detected,
    capabilities,
    onPhaseWritten: (clientId, phase) => {
      const history = phaseHistory.get(clientId) ?? [];
      history.push(phase);
      phaseHistory.set(clientId, history);
      const interruptPhase = oneShotInterrupts.get(clientId);
      if (interruptPhase === phase) {
        oneShotInterrupts.delete(clientId);
        throw new InterruptedProvisioningError(clientId, phase);
      }
    },
  };

  const service = buildService(deps);

  return {
    provision: (ids) => service.provision(ids),
    provisionAll: () => service.provisionAll(),
    recoverOnStartup: () => service.recoverOnStartup(),
    inventory: () => service.inventory(),
    installedSkillNames: (clientId) => port.installedSkillNames(clientId, capabilityForFixture(capabilities, clientId)),
    packagedSkillNames: () => port.packagedSkillNames(),
    failSkillsFor: port.failSkillsFor,
    interruptAfter: (phase, clientId) => { oneShotInterrupts.set(clientId, phase); },
    marker: (clientId) => {
      const read = readMarker(stateDir, clientId);
      return read.status === 'ok' ? read.marker : null;
    },
    registrationEntry: (clientId) => port.registrationEntry(clientId),
    phaseHistory: (clientId) => [...(phaseHistory.get(clientId) ?? [])],
    writeCorruptMarker: (clientId) => {
      mkdirSync(join(stateDir, 'provisioning'), { recursive: true });
      writeFileSync(join(stateDir, 'provisioning', `${clientId}.json`), 'not json {{{', 'utf8');
    },
    makeUnrestorable: (clientId) => port.makeUnrestorable(clientId),
    makeRegistrationUnwritable: (clientId) => port.makeRegistrationUnwritable(clientId),
    makeSkillsUnwritable: (clientId) => port.makeSkillsUnwritable(clientId),
    tamperRegistration: (clientId) => port.tamperRegistration(clientId),
    tamperSkills: (clientId) => port.tamperSkills(clientId),
    editRegistrationOutsideMma: (clientId, entry) => port.editRegistrationOutsideMma(clientId, entry),
    deleteSkillBackup: (clientId) => {
      const read = readMarker(stateDir, clientId);
      const backupPath = read.status === 'ok' ? read.marker.priorSkillBackup : null;
      if (backupPath) rmSync(backupPath, { recursive: true, force: true });
    },
    skillBackupDirs: () => {
      const root = join(stateDir, 'provisioning', 'skill-backups');
      try {
        return readdirSync(root);
      } catch {
        return [];
      }
    },
    setClientState: (clientId, state) => { declared[clientId] = state; },
    stateDir,
  };
}

function capabilityForFixture(capabilities: readonly ClientCapability[], clientId: ClientId): ClientCapability {
  const capability = capabilities.find((candidate) => candidate.id === clientId);
  if (!capability) throw new Error(`No capability registry row for client '${clientId}'.`);
  return capability;
}

createProvisioningService.testFixture = buildTestFixture;
