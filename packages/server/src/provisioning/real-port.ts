/**
 * The production `ProvisioningPort` -- wires `service.ts`'s orchestration to
 * the real filesystem via the ownership-safe registration writers (Task I-5/
 * I-6) and skill-directory primitives (Task I-4), and to the packaged skills
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
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import type { ClientCapability } from './capability-registry.js';
import type { RegistrationSnapshot } from './marker-store.js';
import type { PortActionResult, ProvisioningPort, SkillBackupResult } from './provisioning-port.js';
import {
  atomicWriteBytes,
  isOwnedMcpEntry,
  realFsDeps,
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
import { computeSkillDigest, inspectSkillOwnership, readInstalledRegularFiles, SKILL_OWNERSHIP_MARKER_FILE, type RenderedFiles } from './owned-files.js';
import { getSkillsRoot, readSkillContent, SUPPORTED_SKILLS } from '../skill-install/discover.js';
import { inlineIncludes } from '../skill-install/include-utils.js';
import { expandHome } from '../expand-home.js';

export interface RealPortContext {
  homeDir: string;
  daemonPort: number;
  cliEntrypoint: string;
  execPath?: string;
  platform?: string;
  appData?: string;
  /** Release identifier recorded into each skill's ownership marker -- the
   *  running server's own version. */
  release: string;
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
    case 'vscode': return undefined; // BLOCKED -- no verified writer (Task I-6)
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
    if (!metadata.isFile()) continue;
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (relativePath !== SKILL_OWNERSHIP_MARKER_FILE) files.set(relativePath, readFileSync(absolutePath));
  }
  return files;
}

/** Builds the production `ProvisioningPort` against a real home directory. */
export function createRealProvisioningPort(ctx: RealPortContext): ProvisioningPort {
  const skillsRoot = ctx.skillsRoot ?? getSkillsRoot();

  function skillRootFor(capability: ClientCapability): string {
    if (!capability.skillRoot) throw new Error(`client '${capability.id}' has no skill root (strategy 'none')`);
    return expandHome(capability.skillRoot, ctx.homeDir);
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

    async writeRegistration(_clientId: ClientId, capability: ClientCapability): Promise<PortActionResult> {
      const result = await writeClientRegistration(buildWriteInput(capability, ctx));
      return result.status === 'registered' ? { ok: true } : { ok: false, error: result.message ?? `registration write failed for '${capability.id}'` };
    },

    async restoreRegistration(_clientId: ClientId, _capability: ClientCapability, snapshot: RegistrationSnapshot): Promise<PortActionResult> {
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

    async removeRegistration(_clientId: ClientId, capability: ClientCapability): Promise<PortActionResult> {
      const result = await removeClientRegistration(buildWriteInput(capability, ctx));
      return result.status === 'absent' ? { ok: true } : { ok: false, error: result.message ?? `registration removal failed for '${capability.id}'` };
    },

    isRegistrationReachable(_clientId: ClientId, capability: ClientCapability, snapshot: RegistrationSnapshot): boolean {
      if (!isPathWritable(snapshot.path)) return false;
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = readFileSync(snapshot.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
        return false;
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

    async backupSkills(_clientId: ClientId, capability: ClientCapability): Promise<SkillBackupResult> {
      if (capability.skillPathStrategy === 'none') return { backupPath: null, digest: null };
      const root = skillRootFor(capability);
      if (!existsSync(root)) return { backupPath: null, digest: null };
      let backupDir: string | null = null;
      const backedUpFiles = new Map<string, Buffer>();
      for (const name of SUPPORTED_SKILLS) {
        const dir = join(root, name);
        if (!existsSync(dir)) continue;
        const rendered = renderSkill(name, skillsRoot);
        const inspection = await inspectSkillOwnership(dir, rendered, ctx.release);
        if (inspection.state === 'modified-conflict') {
          throw new Error(inspection.reason ?? `refusing to back up skill content whose MMA ownership cannot be proven at ${dir}`);
        }
        if (inspection.state === 'unowned') continue;
        if (!backupDir) backupDir = mkdtempSync(join(tmpdir(), 'mma-skill-backup-'));
        cpSync(dir, join(backupDir, name), { recursive: true });
        for (const [relativePath, bytes] of await readInstalledRegularFiles(dir)) {
          backedUpFiles.set(`${name}/${relativePath}`, bytes);
        }
      }
      return backupDir
        ? { backupPath: backupDir, digest: computeSkillDigest(backedUpFiles) }
        : { backupPath: null, digest: null };
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
            writeFileSync(filePath, bytes);
          }
          writeFileSync(join(dir, SKILL_OWNERSHIP_MARKER_FILE), JSON.stringify({ release: ctx.release, sha256: inspection.digest }));
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async restoreSkills(_clientId: ClientId, capability: ClientCapability, backupPath: string | null): Promise<PortActionResult> {
      if (capability.skillPathStrategy === 'none') return { ok: true };
      const root = skillRootFor(capability);
      try {
        for (const name of SUPPORTED_SKILLS) {
          rmSync(join(root, name), { recursive: true, force: true });
        }
        if (backupPath) {
          mkdirSync(root, { recursive: true });
          for (const name of readdirSync(backupPath)) {
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

    isSkillsReachable(_clientId: ClientId, capability: ClientCapability, priorDigest: string | null): boolean {
      if (capability.skillPathStrategy === 'none') return true;
      const root = skillRootFor(capability);
      if (!isPathWritable(root)) return false;
      const observedFiles = new Map<string, Buffer>();
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
          }
          // An old release is still MMA-owned under the ownership primitive's
          // stale-release rule; it is safe to restore from the captured backup
          // even though this running release cannot re-render its old bytes.
          for (const [relativePath, bytes] of files) observedFiles.set(`${name}/${relativePath}`, bytes);
        } catch {
          return false;
        }
      }
      // Before the skill mutation begins, this exact digest is the marker's
      // recorded precondition.  A later phase may legitimately differ because
      // this operation wrote (or partly wrote) MMA-owned skills; the ownership
      // checks above are then the safe proof that recovery may restore them.
      if (priorDigest !== null && computeSkillDigest(observedFiles) === priorDigest) return true;
      return true;
    },
  };
}
