/**
 * In-memory provisioning fixture — a fake `ProvisioningPort` plus the wiring that runs the REAL
 * orchestration against it, so markers, rollback, shared-root reference counting, and recovery can
 * be exercised without a real disk or a real client's config file.
 *
 * This lived at the bottom of `packages/server/src/provisioning/service.ts`, attached to the
 * production export as `createProvisioningService.testFixture` via a cast. That put ~320 lines of
 * test-only code — a fake port, its simulated-failure switches, and a temp-dir builder — into a
 * production module, where it compiled into `dist/` and shipped to every npm consumer of
 * `@zhixuan92/multi-model-agent`. It also inverted the dependency: production source imported
 * `node:os`/`tmpdir` and reached for `SUPPORTED_SKILLS` purely to serve tests.
 *
 * `InterruptedProvisioningError` moved here with it. Its own doc comment said it is thrown when a
 * TEST's `interruptAfter` hook fires, it was thrown from exactly one place — the fixture — and no
 * production code catches it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_CAPABILITIES, type ClientCapability } from '../../../packages/server/src/provisioning/capability-registry.js';
import type { DeclaredClientRoster } from '../../../packages/server/src/provisioning/roster.js';
import {
  readMarker,
  type ProvisioningMarker,
  type ProvisioningPhase,
  type RegistrationFingerprint,
  type RegistrationSnapshot,
} from '../../../packages/server/src/provisioning/marker-store.js';
import type { ClientInventoryRecord } from '../../../packages/server/src/provisioning/inventory.js';
import type { AcquireLockOptions } from '../../../packages/server/src/provisioning/provisioning-lock.js';
import type { ProvisioningPort, RegistrationMutationResult } from '../../../packages/server/src/provisioning/provisioning-port.js';
import {
  createProvisioningService,
  type ProvisioningServiceDeps,
  type ProvisionRunResult,
  type RecoveryReport,
} from '../../../packages/server/src/provisioning/service.js';
import { computeSkillDigest } from '../../../packages/server/src/provisioning/owned-files.js';
import { SUPPORTED_SKILLS } from '../../../packages/server/src/skill-install/discover.js';

/** Thrown when a test's `interruptAfter` hook fires — simulates the process dying immediately
 *  after a marker phase was durably written. The marker on disk is left exactly as written;
 *  nothing further runs for this client. */
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

export interface TestFixtureOptions {
  clients?: Partial<Record<ClientId, 'on' | 'off'>>;
  /** Shorten the cross-process lock's patience so a contention test does not
   *  have to wait out the production 30s timeout. */
  lockOptions?: AcquireLockOptions;
  failRegistrationFor?: Set<ClientId>;
  detected?: ReadonlySet<ClientId>;
  capabilities?: readonly ClientCapability[];
}

export interface ProvisioningTestFixture {
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

export function provisioningTestFixture(options: TestFixtureOptions = {}): ProvisioningTestFixture {
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
    ...(options.lockOptions ? { lockOptions: options.lockOptions } : {}),
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

  const service = createProvisioningService(deps);

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
