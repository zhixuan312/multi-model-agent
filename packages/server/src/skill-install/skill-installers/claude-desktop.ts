/**
 * Claude Desktop MCP configuration — install, uninstall, and detection.
 *
 * This writer is deliberately NOT a skill installer, and Claude Desktop is
 * deliberately NOT a member of the `Client` union in `../manifest.ts`. Desktop has
 * no skills mechanism, and `Client`/`ALL_CLIENTS` feed `sync-skills --all-targets`,
 * so listing Desktop there would make the skill installer try to install skills into
 * a client that cannot have any. Desktop is reached through `mma mcp install` /
 * `mma mcp uninstall` instead, and `manifest.ts` / `discover.ts` stay untouched.
 *
 * `claude_desktop_config.json` belongs to the USER: it holds their preferences and
 * any MCP servers they wrote by hand. Two rules follow from that, and they are the
 * reason this module is more careful than a JSON merge:
 *
 *   1. **Only touch an entry we can recognise as ours.** A key-shape check alone
 *      cannot prove ownership — `mma` is a plausible name for a hand-written entry.
 *      See {@link isOwnedClaudeDesktopMcpEntry}. Install and uninstall apply the SAME
 *      recogniser; an asymmetry would let uninstall delete precisely what install is
 *      required to protect.
 *   2. **Refuse rather than clobber.** Any config we cannot merge safely — bad JSON,
 *      wrong shape, or a foreign `mma` entry — aborts with the offending field named
 *      and the file's bytes untouched. A backup is a recovery mechanism, not consent.
 *
 * All byte-changing writes go through the single crash-safe seam in
 * `../claude-desktop-file.ts`.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type {
  AtomicClaudeDesktopFileDeps,
  AtomicClaudeDesktopWriteInput,
} from '../claude-desktop-file.js';

/** The single MCP server name this module owns inside `mcpServers`. */
export const CLAUDE_DESKTOP_MCP_KEY = 'mma';

/** The entrypoint suffix an MMA-written entry always points at (POSIX-normalized). */
const ENTRYPOINT_SUFFIX = 'dist/cli/index.js';

/**
 * Refuse the write when the config changed between our read and our rename.
 *
 * The merge is computed from bytes read earlier, and the atomic rename replaces the
 * whole file. If Claude Desktop saved its own settings — or a concurrent `mma mcp
 * install`/`uninstall` ran — in that window, renaming a stale merge over the newer
 * bytes silently discards the user's most recent edit. That is exactly the outcome this
 * module exists to prevent, so re-check immediately before handing off to the writer
 * and abort instead. Atomic replacement guarantees no torn file; it does not guarantee
 * the file is still the one we merged.
 */
function assertConfigUnchanged(
  deps: ClaudeDesktopDeps,
  configPath: string,
  expected: Buffer | undefined,
): void {
  const read = deps.readConfig ?? ((p: string) => (existsSync(p) ? readFileSync(p) : undefined));
  const current = read(configPath);
  const same = expected === undefined ? current === undefined : current !== undefined && current.equals(expected);
  if (!same) {
    throw new Error(
      `Refusing to modify ${configPath}: it changed on disk while this command was preparing its update `
      + '(Claude Desktop may have saved, or another mma command ran). Nothing was written — re-run the command.',
    );
  }
}

export interface ClaudeDesktopDeps {
  /** `process.platform`. Typed as string because callers and tests assign it freely. */
  platform: string;
  homeDir: string;
  appData: string;
  localAppData: string;
  /** Absolute path of the Node binary that will launch the bridge (`process.execPath`). */
  execPath: string;
  /** Absolute path of the installing distribution's `dist/cli/index.js`. */
  resolveEntrypoint: () => string;
  exists: (path: string) => boolean;
  /** Optional: when omitted the resolved config path is read from the real filesystem
   *  (undefined when absent). Omitting it is a deliberate "use the real disk" signal. */
  readConfig?: (path: string) => Buffer | undefined;
  atomicWriteClaudeDesktopConfig: (
    input: AtomicClaudeDesktopWriteInput,
    deps: AtomicClaudeDesktopFileDeps,
  ) => Promise<string | null>;
}

export interface ClaudeDesktopDetection {
  detected: boolean;
  /** Always `mcp-only` — Desktop receives MCP configuration, never skills. */
  support: 'mcp-only';
  configPath: string;
  evidence: 'config' | 'app-directory' | null;
}

/** Windows paths are built with backslashes explicitly: this module may run on POSIX
 *  (where `path.join` would emit `/`) while resolving a Windows location. */
function winJoin(...parts: string[]): string {
  return parts.join('\\').replace(/\\+/g, '\\');
}

function isWindows(platform: string): boolean {
  return platform === 'win32';
}

/** macOS: `~/Library/Application Support/Claude/…`; Windows: `%APPDATA%\Claude\…`. */
export function resolveClaudeDesktopConfigPath(deps: Pick<ClaudeDesktopDeps, 'platform' | 'homeDir' | 'appData'>): string {
  if (isWindows(deps.platform)) {
    return winJoin(deps.appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(deps.homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/** Windows app install directory, used only as detection evidence. */
function claudeAppDirectory(deps: Pick<ClaudeDesktopDeps, 'platform' | 'localAppData'>): string {
  return isWindows(deps.platform)
    ? winJoin(deps.localAppData, 'Programs', 'Claude')
    : '/Applications/Claude.app';
}

/**
 * Detect Claude Desktop from either its config file or its application directory.
 * Never performs a network call and never depends on a running daemon.
 */
export function detectClaudeDesktop(deps: ClaudeDesktopDeps): ClaudeDesktopDetection {
  const configPath = resolveClaudeDesktopConfigPath(deps);
  const evidence: ClaudeDesktopDetection['evidence'] = deps.exists(configPath)
    ? 'config'
    : deps.exists(claudeAppDirectory(deps))
      ? 'app-directory'
      : null;
  return { detected: evidence !== null, support: 'mcp-only', configPath, evidence };
}

function isAbsolutePathFor(platform: string, candidate: string): boolean {
  if (isWindows(platform)) return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
  return candidate.startsWith('/');
}

/**
 * Is this `mcpServers.mma` value an entry MMA itself wrote?
 *
 * All three conditions must hold, and together they describe exactly what
 * {@link installClaudeDesktop} emits:
 *
 *   1. its key set is a subset of `{command, args}`;
 *   2. `args` is an array whose LAST element is exactly `"mcp"`;
 *   3. `args[0]` is an absolute path ending in `dist/cli/index.js`.
 *
 * A no-`command` entry is deliberately accepted: an older or hand-trimmed MMA entry
 * may carry only `args`, and refusing it would strand the user with an entry neither
 * install nor uninstall would touch.
 */
export function isOwnedClaudeDesktopMcpEntry(value: unknown, platform: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (key !== 'command' && key !== 'args') return false;
  }
  const args = entry.args;
  if (!Array.isArray(args) || args.length < 2) return false;
  if (args[args.length - 1] !== 'mcp') return false;
  const first = args[0];
  if (typeof first !== 'string' || !isAbsolutePathFor(platform, first)) return false;
  return first.replace(/\\/g, '/').endsWith(ENTRYPOINT_SUFFIX);
}

/** Why an existing `mcpServers.mma` was rejected — surfaced so the user can fix it. */
function ownershipFailureReason(entry: Record<string, unknown>, platform: string): string {
  const extra = Object.keys(entry).filter((k) => k !== 'command' && k !== 'args');
  if (extra.length) return `it carries unexpected key(s) ${extra.join(', ')} (only command/args are written by MMA)`;
  const args = entry.args;
  if (!Array.isArray(args)) return 'its "args" is not an array';
  if (args[args.length - 1] !== 'mcp') return 'its "args" does not end with "mcp"';
  const first = args[0];
  if (typeof first !== 'string') return 'its "args[0]" is not a string';
  if (!isAbsolutePathFor(platform, first)) return `its "args[0]" (${first}) is not an absolute path`;
  return `its "args[0]" (${first}) does not end with ${ENTRYPOINT_SUFFIX}`;
}

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

interface LoadedConfig {
  /** undefined when the config file does not exist. */
  originalBytes: Buffer | undefined;
  root: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
}

/**
 * Read and validate the config, refusing every shape that cannot be merged safely.
 *
 * A rule guarding only "malformed JSON" would leave the dangerous case open: valid
 * JSON of the WRONG SHAPE would be silently replaced, destroying a real value with no
 * error. So each unsafe shape is enumerated and reported with its field path.
 */
function loadConfig(deps: ClaudeDesktopDeps, configPath: string): LoadedConfig {
  const read = deps.readConfig ?? ((p: string) => (existsSync(p) ? readFileSync(p) : undefined));
  const originalBytes = read(configPath);
  if (originalBytes === undefined) return { originalBytes: undefined, root: {}, mcpServers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(originalBytes.toString('utf8'));
  } catch (err) {
    // A syntax error has no field path — only a failing offset — so report the
    // parser's position rather than inventing a path.
    throw new Error(
      `Refusing to modify ${configPath}: it is not valid JSON, so no field path can be named — only the failing offset. `
      + `Parser reported: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Refusing to modify ${configPath}: its JSON root is ${describeJsonType(parsed)}, expected an object.`);
  }
  const root = parsed as Record<string, unknown>;

  let mcpServers: Record<string, unknown> = {};
  if ('mcpServers' in root) {
    const raw = root.mcpServers;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Refusing to modify ${configPath}: "mcpServers" is ${describeJsonType(raw)}, expected an object.`);
    }
    mcpServers = raw as Record<string, unknown>;
  }

  if (CLAUDE_DESKTOP_MCP_KEY in mcpServers) {
    const entry = mcpServers[CLAUDE_DESKTOP_MCP_KEY];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Refusing to modify ${configPath}: "mcpServers.${CLAUDE_DESKTOP_MCP_KEY}" is ${describeJsonType(entry)}, expected an object.`,
      );
    }
    if (!isOwnedClaudeDesktopMcpEntry(entry, deps.platform)) {
      throw new Error(
        `Refusing to modify ${configPath}: "mcpServers.${CLAUDE_DESKTOP_MCP_KEY}" was not written by MMA — `
        + `${ownershipFailureReason(entry as Record<string, unknown>, deps.platform)}. `
        + 'Remove or rename that entry yourself if you want MMA to manage it.',
      );
    }
  }

  return { originalBytes, root, mcpServers };
}

/** Two-space JSON plus a trailing newline — the shape Claude Desktop itself writes. */
function serialize(root: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

/** Real-filesystem operations for the atomic seam. */
function realSeamDeps(): AtomicClaudeDesktopFileDeps {
  return {
    findExistingDesktopBackup: (configPath) => {
      const dir = dirname(configPath);
      const prefix = `${basename(configPath)}.bak.`;
      try {
        const hit = readdirSync(dir).find((f) => f.startsWith(prefix));
        return hit === undefined ? undefined : join(dir, hit);
      } catch {
        return undefined;
      }
    },
    // A SIBLING FILE of the config — same directory, therefore the same filesystem,
    // which is what makes the rename atomic. Deliberately not a temp *directory*:
    // renaming the file out of one would leave the empty directory behind next to the
    // user's config on every write.
    createTemp: (configPath) => `${configPath}.mma-tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
    write: (path, bytes) => writeFileSync(path, bytes),
    writeBackup: (path, bytes) => writeFileSync(path, bytes),
    fsync: (path) => {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    rename: (from, to) => renameSync(from, to),
    // Remove the temp FILE only. Never the directory — that is the directory holding
    // the user's live configuration.
    remove: (path) => rmSync(path, { force: true }),
    now: () => new Date(),
  };
}

/** The entry MMA writes. `command` is the absolute Node binary and `args[0]` the
 *  absolute JS entrypoint — never a bare `mma`, never `npx`, and never a `.js` path
 *  as `command`. Rationale: the entrypoint's shebang needs `node` on PATH and macOS
 *  GUI apps do not inherit the shell PATH; a `.js` file is not executable as a bare
 *  `command` on Windows at all; and the `mma` on PATH may be a different, older
 *  build than the one installing. No `env`, and never a credential. */
function buildEntry(deps: ClaudeDesktopDeps): { command: string; args: string[] } {
  const entrypoint = deps.resolveEntrypoint();
  for (const [label, candidate] of [['Node binary', deps.execPath], ['entrypoint', entrypoint]] as const) {
    if (!candidate || !isAbsolutePathFor(deps.platform, candidate)) {
      throw new Error(`Refusing to write Claude Desktop config: the resolved ${label} (${candidate || '<empty>'}) is not an absolute path.`);
    }
    if (!deps.exists(candidate)) {
      throw new Error(`Refusing to write Claude Desktop config: the resolved ${label} (${candidate}) does not exist on disk.`);
    }
  }
  return { command: deps.execPath, args: [entrypoint, 'mcp'] };
}

export interface ClaudeDesktopWriteResult {
  configPath: string;
  /** Always `mcp-only`: Desktop receives MCP configuration, not skills. */
  support: 'mcp-only';
  changed: boolean;
  backupPath: string | null;
}

/** Add or update `mcpServers.mma`, preserving every other value byte-for-byte. */
export async function installClaudeDesktop(deps: ClaudeDesktopDeps): Promise<ClaudeDesktopWriteResult> {
  const configPath = resolveClaudeDesktopConfigPath(deps);
  const { originalBytes, root, mcpServers } = loadConfig(deps, configPath);
  // Validate the launch paths BEFORE composing any write, so a bad resolution cannot
  // leave a partially updated config.
  const entry = buildEntry(deps);

  const nextRoot: Record<string, unknown> = {
    ...root,
    mcpServers: { ...mcpServers, [CLAUDE_DESKTOP_MCP_KEY]: entry },
  };
  const nextBytes = serialize(nextRoot);
  if (originalBytes !== undefined && originalBytes.equals(nextBytes)) {
    return { configPath, support: 'mcp-only', changed: false, backupPath: null };
  }
  assertConfigUnchanged(deps, configPath, originalBytes);
  const backupPath = await deps.atomicWriteClaudeDesktopConfig({ configPath, originalBytes, nextBytes }, realSeamDeps());
  return { configPath, support: 'mcp-only', changed: true, backupPath };
}

/** Remove `mcpServers.mma` and nothing else. Applies the SAME ownership recogniser as
 *  install (via {@link loadConfig}), so it cannot delete a hand-written entry that
 *  install would have refused to overwrite. */
export async function uninstallClaudeDesktop(deps: ClaudeDesktopDeps): Promise<ClaudeDesktopWriteResult> {
  const configPath = resolveClaudeDesktopConfigPath(deps);
  const { originalBytes, root, mcpServers } = loadConfig(deps, configPath);
  if (originalBytes === undefined || !(CLAUDE_DESKTOP_MCP_KEY in mcpServers)) {
    return { configPath, support: 'mcp-only', changed: false, backupPath: null };
  }

  const remaining = { ...mcpServers };
  delete remaining[CLAUDE_DESKTOP_MCP_KEY];
  const nextBytes = serialize({ ...root, mcpServers: remaining });
  assertConfigUnchanged(deps, configPath, originalBytes);
  const backupPath = await deps.atomicWriteClaudeDesktopConfig({ configPath, originalBytes, nextBytes }, realSeamDeps());
  return { configPath, support: 'mcp-only', changed: true, backupPath };
}
