/**
 * The production `ProvisioningPort` -- wires `service.ts`'s orchestration to
 * the real filesystem via the ownership-safe registration writers
 * (`registration-writer.ts`, `writers/*.ts`) and skill-directory primitives
 * (`owned-files.ts`), and to the packaged skills
 * shipped under `skills/` (rendered the same way the legacy installer did:
 * `SKILL.md` + `@include` resolution).
 */
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import type { ClientCapability } from './capability-registry.js';
import type { RegistrationFingerprint, RegistrationSnapshot } from './marker-store.js';
import type { PortActionResult, ProvisioningPort, RegistrationMutationResult, SkillBackupResult } from './provisioning-port.js';
import { atomicWriteBytes, realFsDeps } from './atomic-write.js';
import {
  isOwnedMcpEntry,
  removeClientRegistration,
  writeClientRegistration,
  type WriteClientRegistrationInput,
} from './registration-writer.js';
import { claudeCodeRegistrationPath } from './writers/claude-code.js';
import { resolveClaudeDesktopPath } from './writers/claude-desktop.js';
import { codexRegistrationPath, isCodexTableOwned, isCodexTableOwnedOrAbsent } from './writers/codex.js';
import { antigravityRegistrationPath } from './writers/antigravity.js';
import { cursorRegistrationPath } from './writers/cursor.js';
import { opencodeRegistrationPath } from './writers/opencode.js';
import { windsurfRegistrationPath } from './writers/windsurf.js';
import {
  computeSkillDigest,
  inspectSkillOwnership,
  readInstalledRegularFiles,
  SKILL_OWNERSHIP_MARKER_FILE,
  UnprovableSkillEntryError,
  type RenderedFiles,
} from './owned-files.js';
import { getSkillsRoot, readSkillContent, SUPPORTED_SKILLS } from '../skill-install/discover.js';
import { inlineIncludes } from '../skill-install/include-utils.js';
import { expandHome } from '../expand-home.js';

interface RealPortContext {
  homeDir: string;
  daemonPort: number;
  cliEntrypoint: string;
  execPath?: string;
  platform?: string;
  appData?: string;
  /** Release identifier recorded into each skill's ownership marker -- the
   *  running server's own version. */
  release: string;
  /** The same state directory the markers live under. Skill backups are stored
   *  beside them rather than in the OS temp directory: a marker can outlive a
   *  reboot (that is the whole point of a durable marker), and many platforms
   *  clear `/tmp` on boot -- so a temp-dir backup could vanish before the
   *  recovery that needs it ever runs. */
  stateDir: string;
  /** Override for tests; defaults to the packaged skills directory. */
  skillsRoot?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nearestExistingDir(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function isPathWritable(path: string): boolean {
  try {
    const target = existsSync(path) ? path : nearestExistingDir(path);
    accessSync(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function registrationPathFor(capability: ClientCapability, ctx: RealPortContext): string | undefined {
  switch (capability.id) {
    case 'claude-code': return claudeCodeRegistrationPath(ctx.homeDir);
    case 'claude-desktop':
      return resolveClaudeDesktopPath({
        capability, homeDir: ctx.homeDir, daemonPort: ctx.daemonPort, cliEntrypoint: ctx.cliEntrypoint,
        execPath: ctx.execPath, platform: ctx.platform, appData: ctx.appData,
      });
    case 'codex': return codexRegistrationPath(ctx.homeDir);
    case 'antigravity': return antigravityRegistrationPath(ctx.homeDir);
    case 'cursor': return cursorRegistrationPath(ctx.homeDir);
    case 'opencode': return opencodeRegistrationPath(ctx.homeDir);
    case 'windsurf': return windsurfRegistrationPath(ctx.homeDir);
    case 'vscode': return undefined; // BLOCKED -- no verified user-level path, so no writer
    default: return undefined;
  }
}

function buildWriteInput(capability: ClientCapability, ctx: RealPortContext, fs?: WriteClientRegistrationInput['fs']): WriteClientRegistrationInput {
  return {
    capability,
    homeDir: ctx.homeDir,
    daemonPort: ctx.daemonPort,
    cliEntrypoint: ctx.cliEntrypoint,
    execPath: ctx.execPath,
    platform: ctx.platform,
    appData: ctx.appData,
    fs,
  };
}

function renderSkill(name: string, skillsRoot: string): RenderedFiles {
  const raw = readSkillContent(name, skillsRoot);
  if (raw === null) throw new Error(`packaged skill '${name}' not found under ${skillsRoot}`);
  const content = inlineIncludes(name, raw, skillsRoot);
  return new Map([['SKILL.md', Buffer.from(content, 'utf8')]]);
}

/** Synchronous counterpart to `readInstalledRegularFiles`, used by the
 * synchronous inventory/reachability port methods.  It deliberately applies
 * the same ownership-digest rules: regular files only, POSIX relative paths,
 * and no root `.mma-install.json` in the digest. */
function readInstalledRegularFilesSync(root: string, current = root): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(current)) {
    const absolutePath = join(current, name);
    const metadata = lstatSync(absolutePath);
    if (metadata.isDirectory()) {
      for (const [relativePath, bytes] of readInstalledRegularFilesSync(root, absolutePath)) files.set(relativePath, bytes);
      continue;
    }
    // Same rule as the async walk: a non-regular entry makes ownership
    // unprovable rather than merely absent from the digest. Both read-only
    // callers below already treat a throw as "not ownership-proven".
    if (!metadata.isFile()) throw new UnprovableSkillEntryError(absolutePath);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (relativePath !== SKILL_OWNERSHIP_MARKER_FILE) files.set(relativePath, readFileSync(absolutePath));
  }
  return files;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write one skill file, never through a symlink.
 *
 * `writeFileSync` follows a symlink at the target path and truncates whatever it
 * points at -- which for a path inside a user-writable skill directory means a
 * write can land anywhere on disk. Unlinking first makes the write create a fresh
 * regular file instead. Ownership inspection already refuses a directory
 * containing a symlink, so this is the second of two independent guards rather
 * than the only one; keeping both means neither has to be perfect alone.
 */
function writeSkillFile(filePath: string, bytes: Buffer | Uint8Array): void {
  rmSync(filePath, { force: true });
  writeFileSync(filePath, bytes);
}

/** Whether `candidate` resolves to something strictly inside `root`. Used before
 *  any recursive delete of a path that came from a user-editable marker. */
function isInsideBackupsRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Builds the production `ProvisioningPort` against a real home directory. */
export function createRealProvisioningPort(ctx: RealPortContext): ProvisioningPort {
  const skillsRoot = ctx.skillsRoot ?? getSkillsRoot();

  function skillRootFor(capability: ClientCapability): string {
    if (!capability.skillRoot) throw new Error(`client '${capability.id}' has no skill root (strategy 'none')`);
    return expandHome(capability.skillRoot, ctx.homeDir);
  }

  /** What the registration file at `capability`'s path currently is. */
  function fingerprintRegistration(capability: ClientCapability): RegistrationFingerprint {
    const path = registrationPathFor(capability, ctx);
    if (!path) return { existed: false, sha256: null };
    try {
      return { existed: true, sha256: sha256Of(readFileSync(path)) };
    } catch {
      return { existed: false, sha256: null };
    }
  }

  /** Every skill backup for this installation lives under one directory beside
   *  the markers that reference it, so a single well-known path holds them all
   *  and an orphan is visible rather than scattered through the OS temp root. */
  function backupsRoot(): string {
    return join(ctx.stateDir, 'provisioning', 'skill-backups');
  }

  return {
    readRegistration(_clientId: ClientId, capability: ClientCapability) {
      const path = registrationPathFor(capability, ctx) ?? '';
      if (!path) return { path, existed: false, bytes: null };
      try {
        return { path, existed: true, bytes: readFileSync(path) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path, existed: false, bytes: null };
        throw err;
      }
    },

    async writeRegistration(_clientId: ClientId, capability: ClientCapability): Promise<RegistrationMutationResult> {
      const result = await writeClientRegistration(buildWriteInput(capability, ctx));
      if (result.status !== 'registered') {
        return { ok: false, error: result.message ?? `registration write failed for '${capability.id}'` };
      }
      return { ok: true, fingerprint: fingerprintRegistration(capability) };
    },

    async restoreRegistration(_clientId: ClientId, capability: ClientCapability, snapshot: RegistrationSnapshot): Promise<PortActionResult> {
      // `snapshot.path` came out of a marker file the running user can edit, and
      // it is about to be written to or deleted. The capability registry -- not
      // the marker -- decides where this client's registration lives, so any
      // disagreement means the marker is not describing this client's file.
      const expected = registrationPathFor(capability, ctx);
      if (!expected || resolve(snapshot.path) !== resolve(expected)) {
        return {
          ok: false,
          error: `the marker names ${snapshot.path} as '${capability.id}''s registration, but this installation writes ${expected ?? '(no path)'} -- refusing to restore over a file that is not this client's`,
        };
      }
      try {
        if (snapshot.existed && snapshot.bytesBase64 !== null) {
          mkdirSync(dirname(snapshot.path), { recursive: true });
          atomicWriteBytes(realFsDeps(), snapshot.path, Buffer.from(snapshot.bytesBase64, 'base64'));
        } else {
          rmSync(snapshot.path, { force: true });
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async removeRegistration(_clientId: ClientId, capability: ClientCapability): Promise<RegistrationMutationResult> {
      const result = await removeClientRegistration(buildWriteInput(capability, ctx));
      if (result.status !== 'absent') {
        return { ok: false, error: result.message ?? `registration removal failed for '${capability.id}'` };
      }
      return { ok: true, fingerprint: fingerprintRegistration(capability) };
    },

    isRegistrationReachable(
      _clientId: ClientId,
      capability: ClientCapability,
      snapshot: RegistrationSnapshot,
      postMutation: RegistrationFingerprint | null,
    ): boolean {
      // Same rule as restoreRegistration: a marker naming some other file is not
      // describing this client, and the restore it gates must never be reachable.
      const expected = registrationPathFor(capability, ctx);
      if (!expected || resolve(snapshot.path) !== resolve(expected)) return false;
      if (!isPathWritable(snapshot.path)) return false;
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = readFileSync(snapshot.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Absent now. Only consistent with a mutation that left it absent (or
          // with no registration mutation having happened yet at all).
          return postMutation === null || !postMutation.existed;
        }
        return false;
      }
      if (postMutation !== null) {
        // The restore about to happen writes the WHOLE prior file back. That is
        // only correct while the file is still exactly what this operation left
        // there -- any other content includes somebody else's edit, and putting
        // the snapshot back would silently discard it. Refuse instead; the
        // marker survives and the state is reported, never quietly overwritten.
        if (!postMutation.existed || postMutation.sha256 !== sha256Of(currentBytes)) return false;
      }
      if (capability.mcpConfigFormat === 'toml') {
        return isCodexTableOwnedOrAbsent(currentBytes.toString('utf8'));
      }
      try {
        const parsed: unknown = JSON.parse(currentBytes.toString('utf8'));
        const topKey = capability.mcpTopLevelKey ?? 'mcpServers';
        const servers = isPlainRecord(parsed) ? parsed[topKey] : undefined;
        const mmaEntry = isPlainRecord(servers) ? servers['mma'] : undefined;
        if (mmaEntry === undefined) return true;
        const expectedStdioEntrypoint = capability.mcpConfigFormat === 'stdio-json' ? ctx.cliEntrypoint : undefined;
        return isOwnedMcpEntry(mmaEntry, capability.mcpConfigFormat, expectedStdioEntrypoint);
      } catch {
        return false;
      }
    },

    isRegistrationPresent(_clientId: ClientId, capability: ClientCapability): boolean {
      const path = registrationPathFor(capability, ctx);
      if (!path) return false;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        return false;
      }
      if (capability.mcpConfigFormat === 'toml') return isCodexTableOwned(bytes.toString('utf8'));
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        const topKey = capability.mcpTopLevelKey ?? 'mcpServers';
        const servers = isPlainRecord(parsed) ? parsed[topKey] : undefined;
        const mmaEntry = isPlainRecord(servers) ? servers['mma'] : undefined;
        if (mmaEntry === undefined) return false;
        const expectedStdioEntrypoint = capability.mcpConfigFormat === 'stdio-json' ? ctx.cliEntrypoint : undefined;
        return isOwnedMcpEntry(mmaEntry, capability.mcpConfigFormat, expectedStdioEntrypoint);
      } catch {
        return false;
      }
    },

    packagedSkillNames(): string[] {
      return [...SUPPORTED_SKILLS];
    },

    async backupSkills(clientId: ClientId, capability: ClientCapability): Promise<SkillBackupResult> {
      if (capability.skillPathStrategy === 'none') return { backupPath: null, digest: null };
      const root = skillRootFor(capability);
      if (!existsSync(root)) return { backupPath: null, digest: null };
      let backupDir: string | null = null;
      const backedUpFiles = new Map<string, Buffer>();
      try {
        for (const name of SUPPORTED_SKILLS) {
          const dir = join(root, name);
          if (!existsSync(dir)) continue;
          const rendered = renderSkill(name, skillsRoot);
          const inspection = await inspectSkillOwnership(dir, rendered, ctx.release);
          if (inspection.state === 'modified-conflict') {
            throw new Error(inspection.reason ?? `refusing to back up skill content whose MMA ownership cannot be proven at ${dir}`);
          }
          if (inspection.state === 'unowned') continue;
          if (!backupDir) {
            mkdirSync(backupsRoot(), { recursive: true });
            backupDir = mkdtempSync(join(backupsRoot(), `${clientId}-`));
          }
          cpSync(dir, join(backupDir, name), { recursive: true });
          for (const [relativePath, bytes] of await readInstalledRegularFiles(dir)) {
            backedUpFiles.set(`${name}/${relativePath}`, bytes);
          }
        }
      } catch (err) {
        // A partial backup is referenced by nothing: this call never returned, so
        // no marker records the path. Left in place it would accumulate silently
        // under stateDir on every retry of a conflict that keeps failing. The
        // cleanup is itself guarded -- a failure to delete must never replace the
        // ownership-conflict error the caller actually needs to see.
        try {
          if (backupDir) rmSync(backupDir, { recursive: true, force: true });
        } catch {
          /* leaked disk under a well-known path, not a reason to mask `err` */
        }
        throw err;
      }
      return backupDir
        ? { backupPath: backupDir, digest: computeSkillDigest(backedUpFiles) }
        : { backupPath: null, digest: null };
    },

    discardSkillBackup(backupPath: string): void {
      // This path arrives from a marker file the running user can edit, and it
      // feeds a recursive delete -- so containment must be checked on the RESOLVED
      // path. A textual prefix test passes `<backupsRoot>/../../../anything`,
      // which is the whole trick; resolving first makes traversal impossible to
      // express rather than merely unlikely.
      if (!isInsideBackupsRoot(backupsRoot(), backupPath)) return;
      try {
        rmSync(backupPath, { recursive: true, force: true });
      } catch {
        /* leaked disk under a well-known path, not a failed operation */
      }
    },

    async installSkills(_clientId: ClientId, capability: ClientCapability): Promise<PortActionResult> {
      if (capability.skillPathStrategy === 'none') return { ok: true };
      const root = skillRootFor(capability);
      try {
        for (const name of SUPPORTED_SKILLS) {
          const dir = join(root, name);
          const rendered = renderSkill(name, skillsRoot);
          const inspection = await inspectSkillOwnership(dir, rendered, ctx.release);
          if (inspection.state === 'modified-conflict') {
            return { ok: false, error: inspection.reason ?? `refusing to overwrite unowned content at ${dir}` };
          }
          mkdirSync(dir, { recursive: true });
          for (const [relPath, bytes] of rendered) {
            const filePath = join(dir, relPath);
            mkdirSync(dirname(filePath), { recursive: true });
            writeSkillFile(filePath, bytes);
          }
          writeSkillFile(join(dir, SKILL_OWNERSHIP_MARKER_FILE), Buffer.from(JSON.stringify({ release: ctx.release, sha256: inspection.digest })));
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /**
     * Put back exactly what `backupSkills` captured.
     *
     * The ordering matters more than it looks: the backup is READ FIRST, in
     * full, and only then is anything live removed. Removing first and
     * discovering afterwards that the backup is gone would leave neither copy --
     * turning a recoverable interrupted install into permanent data loss.
     *
     * A `null` backup is not a missing backup: it means the root held no
     * MMA-owned content when this operation began, so removing what this
     * operation wrote IS the restore. That also makes the shared-root case safe
     * without a peer check -- if a sibling client's skills had been installed at
     * this shared root, the backup would have captured them and would not be
     * null.
     */
    async restoreSkills(
      _clientId: ClientId,
      capability: ClientCapability,
      backupPath: string | null,
      expectedDigest: string | null,
    ): Promise<PortActionResult> {
      if (capability.skillPathStrategy === 'none') return { ok: true };
      const root = skillRootFor(capability);
      // The containment rule discardSkillBackup applies has to apply here too, and
      // for a stronger reason: this path is not merely deleted, it is COPIED FROM
      // into the client's skill root. Verifying the digest does not help — the
      // digest comes out of the same marker as the path, so a forged pair is
      // self-consistent by construction. Only the path's location distinguishes a
      // backup this port took from a directory someone else chose.
      if (backupPath && !isInsideBackupsRoot(backupsRoot(), backupPath)) {
        return { ok: false, error: `the marker names a skill backup at ${backupPath}, which is not inside this installation's backup directory` };
      }
      try {
        let backedUp: string[] = [];
        if (backupPath) {
          if (!existsSync(backupPath)) {
            return {
              ok: false,
              error: `the skill backup recorded at ${backupPath} no longer exists, so the current content is kept rather than removed with nothing to put back`,
            };
          }
          backedUp = readdirSync(backupPath);
          // Existing is not the same as intact. Read the backup in full and hash
          // it against what `backupSkills` recorded: an emptied or partially
          // deleted backup would otherwise pass the existence check, the live
          // content would be wiped, and only the surviving entries copied back.
          const backedUpFiles = new Map<string, Buffer>();
          for (const name of backedUp) {
            for (const [relativePath, bytes] of await readInstalledRegularFiles(join(backupPath, name))) {
              backedUpFiles.set(`${name}/${relativePath}`, bytes);
            }
          }
          if (computeSkillDigest(backedUpFiles) !== expectedDigest) {
            return {
              ok: false,
              error: `the skill backup at ${backupPath} no longer matches the digest recorded when it was taken, `
                + 'so the current content is kept rather than replaced from an incomplete copy',
            };
          }
        }
        for (const name of SUPPORTED_SKILLS) {
          rmSync(join(root, name), { recursive: true, force: true });
        }
        if (backupPath) {
          mkdirSync(root, { recursive: true });
          for (const name of backedUp) {
            cpSync(join(backupPath, name), join(root, name), { recursive: true });
          }
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async removeSkills(_clientId: ClientId, capability: ClientCapability, enabledPeers: ReadonlySet<ClientId>): Promise<PortActionResult> {
      if (capability.skillPathStrategy === 'none') return { ok: true };
      if (enabledPeers.size > 0) return { ok: true };
      const root = skillRootFor(capability);
      try {
        for (const name of SUPPORTED_SKILLS) {
          const dir = join(root, name);
          if (!existsSync(dir)) continue;
          const rendered = renderSkill(name, skillsRoot);
          const inspection = await inspectSkillOwnership(dir, rendered, ctx.release);
          if (inspection.state === 'modified-conflict') {
            return { ok: false, error: inspection.reason ?? `refusing to remove unowned content at ${dir}` };
          }
          rmSync(dir, { recursive: true, force: true });
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    installedSkillNames(_clientId: ClientId, capability: ClientCapability): string[] {
      if (capability.skillPathStrategy === 'none') return [];
      const root = skillRootFor(capability);
      const names: string[] = [];
      for (const name of SUPPORTED_SKILLS) {
        const dir = join(root, name);
        let marker: unknown;
        try {
          marker = JSON.parse(readFileSync(join(dir, SKILL_OWNERSHIP_MARKER_FILE), 'utf8'));
        } catch {
          continue;
        }
        if (!isPlainRecord(marker) || typeof marker.release !== 'string' || typeof marker.sha256 !== 'string') continue;
        if (marker.release !== ctx.release) continue;
        try {
          const renderedDigest = computeSkillDigest(renderSkill(name, skillsRoot));
          const installedDigest = computeSkillDigest(readInstalledRegularFilesSync(dir));
          if (marker.sha256 === renderedDigest && installedDigest === renderedDigest) names.push(name);
        } catch {
          continue;
        }
      }
      return names;
    },

    isSkillsReachable(_clientId: ClientId, capability: ClientCapability): boolean {
      if (capability.skillPathStrategy === 'none') return true;
      const root = skillRootFor(capability);
      if (!isPathWritable(root)) return false;
      for (const name of SUPPORTED_SKILLS) {
        const dir = join(root, name);
        if (!existsSync(dir)) continue;
        let marker: unknown;
        try {
          marker = JSON.parse(readFileSync(join(dir, SKILL_OWNERSHIP_MARKER_FILE), 'utf8'));
        } catch {
          return false; // present but no trustworthy ownership proof -- unreachable
        }
        if (!isPlainRecord(marker) || typeof marker.release !== 'string' || typeof marker.sha256 !== 'string') return false;
        try {
          const files = readInstalledRegularFilesSync(dir);
          if (marker.release === ctx.release) {
            const renderedDigest = computeSkillDigest(renderSkill(name, skillsRoot));
            if (marker.sha256 !== renderedDigest || computeSkillDigest(files) !== renderedDigest) return false;
          } else if (computeSkillDigest(files) !== marker.sha256) {
            // A superseded release cannot be re-rendered, but its marker recorded
            // its own digest -- the same stale-release rule inspectSkillOwnership
            // applies, so recovery cannot be laxer than installation here.
            return false;
          }
        } catch {
          return false;
        }
      }
      // Every directory present is ownership-proven and the root is writable:
      // restoring over it destroys nothing of the user's. That is the whole
      // predicate -- see the port interface for why comparing against the
      // marker's recorded starting digest would be wrong here rather than
      // merely redundant.
      return true;
    },
  };
}
