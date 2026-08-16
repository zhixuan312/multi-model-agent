/**
 * Durable provisioning markers.
 *
 * A marker is the ONE piece of state that lets provisioning survive a crash
 * mid-mutation. Before service.ts touches a client's registration or skills it
 * writes a marker at `<stateDir>/provisioning/<ClientId>.json` recording enough
 * to either finish or safely undo the operation: the phase it has reached, and a
 * snapshot of whatever existed before it started touching anything.
 *
 * Both operations advance through the same phases, because both mutate the same
 * two assets in the same order: 'started' -> 'registered' -> 'skills-written' ->
 * (marker cleared). A client whose `skillPathStrategy` is 'none' has no skills to
 * touch, so 'registered' is its last phase before the marker clears.
 *
 * A marker still present the next time provisioning runs (or at daemon start) means
 * the previous attempt did not finish cleanly — recovery (service.ts) resolves it
 * before anything else touches that client. Crucially, "did not finish cleanly" is
 * not the same as "did not finish": the phase says which. A marker recording the
 * operation's OWN terminal phase means every mutation succeeded and only the
 * marker-clear step was lost, so recovery finishes the job rather than undoing it.
 * Any earlier phase means the operation stopped mid-mutation, and recovery restores
 * the recorded starting point.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientId, ClientState } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_IDS } from '@zhixuan92/multi-model-agent-core';
import { atomicWriteBytes, realFsDeps } from './atomic-write.js';

type ProvisioningOperation = 'on' | 'off';
export type ProvisioningPhase = 'started' | 'registered' | 'skills-written';

/** A byte-exact snapshot of a client's registration file as it stood immediately
 *  before the current operation touched it -- the restore source on rollback.
 *  `existed: false` means there was nothing there yet (a fresh install); restoring
 *  it means removing whatever this operation wrote, not writing empty bytes. */
export interface RegistrationSnapshot {
  path: string;
  existed: boolean;
  /** Base64 of the exact prior bytes. Always present when `existed` is true. */
  bytesBase64: string | null;
}

/**
 * What a client's registration file looked like immediately AFTER this operation
 * mutated it -- the fingerprint that makes a later whole-file restore safe.
 *
 * The snapshot above says what to put back; this says what the file must still be
 * for putting it back to be correct. Recovery may run long after the crash that
 * left the marker, and the user is free to edit their own MCP config in between —
 * restoring the snapshot over an edited file would silently discard that edit. So
 * restore is gated on the file still being byte-for-byte what MMA left there,
 * applying the same stale-read discipline the registration writer already uses for
 * forward writes (see `registration-writer.ts`'s module doc, point 3).
 */
export interface RegistrationFingerprint {
  /** Whether the file existed at all after the mutation (an 'off' operation may
   *  have removed it entirely). */
  existed: boolean;
  /** SHA-256 of the file's bytes, or `null` when it did not exist. */
  sha256: string | null;
}

/** One provisioning marker, exactly the shape recorded on disk. */
export interface ProvisioningMarker {
  clientId: ClientId;
  operation: ProvisioningOperation;
  intendedState: ClientState;
  phase: ProvisioningPhase;
  /** Snapshot of the registration file from before this operation. Always present:
   *  it is captured before either operation mutates anything, and `existed: false`
   *  — not a null snapshot — is how "there was no file yet" is expressed. Keeping
   *  it non-nullable is what lets the restore path be a single branch rather than
   *  two, one of which nothing could ever reach. */
  priorRegistration: RegistrationSnapshot;
  /** Fingerprint of the registration file as this operation left it, or `null`
   *  before the registration phase has been reached (nothing was written yet, so
   *  there is nothing to detect drift against). */
  postRegistration: RegistrationFingerprint | null;
  /** Absolute path to a REAL, restorable backup directory holding the exact prior
   *  skill-directory bytes for this client's shared/bespoke skill root, or `null`
   *  when there was nothing installed there before this operation (fresh install)
   *  or the client's strategy is 'none'. Never a placeholder -- if a real backup
   *  cannot be produced, the operation must fail rather than record this as null
   *  while claiming the skills phase was reached. */
  priorSkillBackup: string | null;
  /** Digest of the backup above, as it was taken -- the proof that the backup is
   *  still INTACT, checked before any live content is removed. Deliberately not a
   *  check against the live root: a crash mid-install legitimately changes the
   *  live root, which is the situation recovery exists for. The live root is
   *  proven separately, by ownership (see `isSkillsReachable`). */
  priorSkillDigest: string | null;
  startedAt: number;
}

/** Directory every client's marker lives directly under, one JSON file each. */
function markersDir(stateDir: string): string {
  return join(stateDir, 'provisioning');
}

function markerPath(stateDir: string, clientId: ClientId): string {
  return join(markersDir(stateDir), `${clientId}.json`);
}

/**
 * `corrupt` deliberately carries NO copy of the offending bytes.
 *
 * It used to include a `raw: string`, which nothing ever read. Leaving it there was an invitation
 * to log it, and a marker embeds `priorRegistration.bytesBase64` — a byte-exact copy of the user's
 * MCP registration file, which for several clients holds an API key or a token. The recovery
 * report says a marker is unparseable and names the client; an operator reads the file itself.
 */
type ReadMarkerResult =
  | { status: 'absent' }
  | { status: 'corrupt' }
  | { status: 'ok'; marker: ProvisioningMarker };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRegistrationSnapshot(value: unknown): value is RegistrationSnapshot {
  if (!isPlainRecord(value)) return false;
  return typeof value.path === 'string'
    && typeof value.existed === 'boolean'
    && (value.bytesBase64 === null || typeof value.bytesBase64 === 'string');
}

function isRegistrationFingerprint(value: unknown): value is RegistrationFingerprint {
  if (!isPlainRecord(value)) return false;
  return typeof value.existed === 'boolean' && (value.sha256 === null || typeof value.sha256 === 'string');
}

/** Structurally validates a parsed JSON value as a `ProvisioningMarker` -- an
 *  unrecognised shape is treated identically to a parse failure (clause: an
 *  unparseable/corrupt marker must be reported, never silently ignored, but it
 *  also must never be trusted as if it were valid). */
function validateMarker(clientId: ClientId, value: unknown): ProvisioningMarker | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { operation, intendedState, phase, priorRegistration, postRegistration, priorSkillBackup, priorSkillDigest, startedAt } = value;
  if (operation !== 'on' && operation !== 'off') return undefined;
  if (intendedState !== 'on' && intendedState !== 'off') return undefined;
  if (phase !== 'started' && phase !== 'registered' && phase !== 'skills-written') return undefined;
  if (!isRegistrationSnapshot(priorRegistration)) return undefined;
  if (postRegistration !== null && !isRegistrationFingerprint(postRegistration)) return undefined;
  if (priorSkillBackup !== null && typeof priorSkillBackup !== 'string') return undefined;
  if (priorSkillDigest !== null && typeof priorSkillDigest !== 'string') return undefined;
  if (typeof startedAt !== 'number') return undefined;
  return { clientId, operation, intendedState, phase, priorRegistration, postRegistration, priorSkillBackup, priorSkillDigest, startedAt };
}

/** Reads and validates `clientId`'s marker. Distinguishes "no marker" from "a
 *  marker exists but cannot be trusted" -- callers (recovery) must handle the
 *  latter explicitly rather than treating it as if nothing were pending. */
export function readMarker(stateDir: string, clientId: ClientId): ReadMarkerResult {
  let raw: string;
  try {
    raw = readFileSync(markerPath(stateDir, clientId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  const marker = validateMarker(clientId, parsed);
  return marker ? { status: 'ok', marker } : { status: 'corrupt' };
}

/**
 * Writes (or overwrites) `clientId`'s marker via the SAME temp-file + fsync +
 * atomic-rename primitive the registration writers use.
 *
 * A plain in-place `writeFileSync` would undercut the very guarantee this module
 * exists to provide: a crash partway through rewriting the marker would leave a
 * truncated file, and a corrupt marker is the one state recovery cannot act on —
 * it can only report it and wait for an operator. An atomic rename means a crash
 * leaves either the previous phase's marker or the new one, never a torn file
 * between them.
 */
export function writeMarker(stateDir: string, marker: ProvisioningMarker): void {
  mkdirSync(markersDir(stateDir), { recursive: true });
  const { clientId, ...body } = marker;
  atomicWriteBytes(realFsDeps(), markerPath(stateDir, clientId), Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8'));
}

/** Clears `clientId`'s marker -- the terminal step of both a successful
 *  operation and a successfully recovered one. */
export function clearMarker(stateDir: string, clientId: ClientId): boolean {
  try {
    rmSync(markerPath(stateDir, clientId), { force: true });
    return true;
  } catch {
    // A marker that cannot be removed is still unresolved.  Callers must not
    // report a completed operation or successful recovery while it remains.
    return false;
  }
}

/** Every ClientId with a marker currently on disk, in CLIENT_IDS order --
 *  exactly the set recovery must resolve before it is done. */
export function listMarkedClients(stateDir: string): ClientId[] {
  let names: string[];
  try {
    names = readdirSync(markersDir(stateDir));
  } catch {
    return [];
  }
  const present = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
  return CLIENT_IDS.filter((id) => present.has(id));
}
