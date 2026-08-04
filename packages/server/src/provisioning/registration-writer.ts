/**
 * Ownership-safe MCP registration writer.
 *
 * A client's MCP config file (`~/.cursor/mcp.json`, `claude_desktop_config.json`,
 * `~/.codex/config.toml`, ...) belongs to the USER: alongside whatever MMA writes,
 * it can hold entries for other MCP servers the user configured by hand. This
 * module generalises the discipline already proven for Claude Desktop
 * (`skill-install/skill-installers/claude-desktop.ts`) into one seam every writer
 * can share, rather than each writer re-inventing it:
 *
 *   1. **Recognise ONLY an entry MMA owns.** A key-shape check alone cannot prove
 *      ownership — a hand-written entry can happen to look similar. {@link
 *      isOwnedMcpEntry} additionally requires the entry's connection details match
 *      exactly what MMA itself would write (a loopback `/mcp` URL for HTTP-style
 *      transports, or an absolute launcher path ending `mcp` for the stdio-bridge
 *      shape) — never a plain key-presence test.
 *   2. **Refuse rather than clobber.** An existing `mcpServers.mma` (or equivalent)
 *      this module cannot recognise as its own aborts the write entirely, leaving
 *      the file's bytes untouched.
 *   3. **Detect a stale read.** The bytes are read once to compute the merge, then
 *      re-read immediately before the write. If they differ — the user saved the
 *      client, or a concurrent MMA command ran — the write refuses instead of
 *      renaming a stale merge over newer content. Atomic replacement guarantees no
 *      torn file; it does not by itself guarantee the file is still the one that was
 *      merged.
 *   4. **Write via temp file + fsync + atomic rename.** The temp file is a sibling
 *      of the target (same directory, same filesystem) so the rename is atomic; any
 *      failure leaves the original bytes untouched and removes the temp file.
 *   5. **Never persist a static bearer token.** A caller-provided entry containing
 *      an `Authorization: Bearer <token>`-shaped literal is refused outright — the
 *      only credential mechanisms allowed are dynamic ones (env/file interpolation,
 *      a helper script) supplied by the specific writer, never a baked-in secret.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_CAPABILITIES, type McpConfigFormat } from './capability-registry.js';

/** Why a registration write/remove was refused. Surfaced for inventory reporting. */
export type RegistrationConflictReason =
  | 'unrecognised_entry'
  | 'invalid_config'
  | 'stale_bytes'
  | 'static_credential'
  | 'unsupported_format';

/** Thrown by {@link writeOwnedRegistration}/{@link removeOwnedRegistration} whenever
 *  user content, a concurrent write, or an invalid input blocks the mutation. The
 *  file (if any) is guaranteed unchanged when this is thrown. */
export class RegistrationConflictError extends Error {
  readonly code = 'registration_conflict' as const;
  readonly reason: RegistrationConflictReason;

  constructor(reason: RegistrationConflictReason, message: string) {
    super(message);
    this.name = 'RegistrationConflictError';
    this.reason = reason;
  }
}

/** Injected filesystem primitives — narrow and synchronous, mirroring the seam
 *  proven for Claude Desktop, so ordering and failure paths are testable without a
 *  real disk race. Defaults to the real filesystem. */
export interface RegistrationFsDeps {
  /** Current bytes at `path`, or `undefined` when it does not exist. */
  readConfig(path: string): Buffer | undefined;
  createTemp(path: string): string;
  write(path: string, bytes: Buffer): void;
  fsync(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

function realFsDeps(): RegistrationFsDeps {
  return {
    readConfig: (path) => (existsSync(path) ? readFileSync(path) : undefined),
    createTemp: (path) => `${path}.mma-tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
    write: (path, bytes) => writeFileSync(path, bytes),
    fsync: (path) => {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    rename: (from, to) => renameSync(from, to),
    remove: (path) => rmSync(path, { force: true }),
  };
}

/** The single MCP server name every writer targets inside `mcpServers`. */
const MMA_ENTRY_KEY = 'mma';

/** Matches only a loopback URL pointing at MMA's own MCP endpoint — the exact shape
 *  every HTTP-style writer renders. A user's own local MCP proxy would need to
 *  coincidentally match this precise host+path to be misidentified. */
const LOOPBACK_MCP_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mcp$/;

/** The distribution entrypoint every MMA stdio bridge launches. Matching this
 * suffix prevents an arbitrary absolute command with an `mcp` argument from
 * being mistaken for an MMA-owned entry. */
const MMA_STDIO_ENTRYPOINT_SUFFIX = 'dist/cli/index.js';

/** Matches a literal bearer value wherever it appears in a serialized entry. Dynamic
 *  `${VAR}` and `{env:VAR}` / `{file:path}` substitutions remain allowed because
 *  the client resolves them at connection time rather than serializing a secret. */
const STATIC_BEARER_TOKEN_PATTERN = /Bearer\s+(?!\$\{[^}]+\}|\{(?:env|file):[^}]+\})[^\s"\\]+/;

function isAbsolutePathLike(candidate: string): boolean {
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

/**
 * Is this `mcpServers.mma` (or equivalent) value an entry MMA itself wrote?
 *
 * Dispatches on the client's `mcpConfigFormat`:
 *  - `stdio-json` (the Claude Desktop bridge shape): key set ⊆ `{command, args}`,
 *    `args` ends with `"mcp"`, and `args[0]` is an absolute MMA distribution
 *    entrypoint ending in `dist/cli/index.js`.
 *  - every other supported format (`json`, `plugin-json`): key set ⊆
 *    `{url, serverUrl, headers, env}` and the URL is exactly MMA's own loopback
 *    `/mcp` endpoint.
 */
export function isOwnedMcpEntry(value: unknown, format: McpConfigFormat): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;

  if (format === 'stdio-json') {
    for (const key of Object.keys(entry)) {
      if (key !== 'command' && key !== 'args') return false;
    }
    const args = entry.args;
    if (!Array.isArray(args) || args.length < 2) return false;
    if (args[args.length - 1] !== 'mcp') return false;
    const first = args[0];
    return typeof first === 'string'
      && isAbsolutePathLike(first)
      && first.replace(/\\/g, '/').endsWith(MMA_STDIO_ENTRYPOINT_SUFFIX);
  }

  const allowedKeys = new Set(['url', 'serverUrl', 'headers', 'env']);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) return false;
  }
  const url = entry.url ?? entry.serverUrl;
  return typeof url === 'string' && LOOPBACK_MCP_URL.test(url);
}

function resolveFormat(clientId: ClientId): McpConfigFormat {
  const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === clientId);
  if (!capability) {
    throw new RegistrationConflictError('unsupported_format', `No capability registry row for client '${clientId}'.`);
  }
  return capability.mcpConfigFormat;
}

function assertSupportedFormat(clientId: ClientId, format: McpConfigFormat): void {
  if (format !== 'json' && format !== 'plugin-json' && format !== 'stdio-json') {
    throw new RegistrationConflictError(
      'unsupported_format',
      `writeOwnedRegistration does not yet support the '${format}' format needed for '${clientId}'.`,
    );
  }
}

function assertNoStaticCredential(entry: unknown): void {
  if (STATIC_BEARER_TOKEN_PATTERN.test(JSON.stringify(entry) ?? '')) {
    throw new RegistrationConflictError(
      'static_credential',
      'Refusing to write a static bearer token into a registration entry; use a dynamic credential mechanism instead.',
    );
  }
}

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

interface ParsedJsonConfig {
  root: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
}

/** Parses config bytes, refusing every shape that cannot be merged safely — the same
 *  discipline as Claude Desktop's `loadConfig`, generalised: a syntax error reports
 *  the parser's offset (there is no field path for it), and a wrong-shaped
 *  `mcpServers` reports its own type rather than being silently replaced. */
function parseJsonConfig(path: string, bytes: Buffer | undefined): ParsedJsonConfig {
  if (bytes === undefined) return { root: {}, mcpServers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new RegistrationConflictError(
      'invalid_config',
      `Refusing to modify ${path}: it is not valid JSON, so no field path can be named — only the failing offset. `
      + `Parser reported: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RegistrationConflictError('invalid_config', `Refusing to modify ${path}: its JSON root is ${describeJsonType(parsed)}, expected an object.`);
  }
  const root = parsed as Record<string, unknown>;

  let mcpServers: Record<string, unknown> = {};
  if ('mcpServers' in root) {
    const raw = root.mcpServers;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RegistrationConflictError('invalid_config', `Refusing to modify ${path}: "mcpServers" is ${describeJsonType(raw)}, expected an object.`);
    }
    mcpServers = raw as Record<string, unknown>;
  }
  return { root, mcpServers };
}

/** Two-space JSON plus a trailing newline — the shape these config files are
 *  conventionally written in by their own clients. */
function serializeJsonConfig(root: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

/** Refuse the write when the config changed between the initial read and now. See
 *  the module doc's point 3 — this is what makes atomic replacement safe against a
 *  concurrent save rather than merely torn-file-safe. */
function assertBytesUnchanged(fs: RegistrationFsDeps, path: string, expected: Buffer | undefined): void {
  const current = fs.readConfig(path);
  const unchanged = expected === undefined ? current === undefined : current !== undefined && current.equals(expected);
  if (!unchanged) {
    throw new RegistrationConflictError(
      'stale_bytes',
      `Refusing to modify ${path}: it changed on disk while this write was preparing its update `
      + '(the client may have saved, or another mma command ran). Nothing was written — re-run.',
    );
  }
}

function atomicWriteBytes(fs: RegistrationFsDeps, path: string, bytes: Buffer): void {
  const tempPath = fs.createTemp(path);
  try {
    fs.write(tempPath, bytes);
    fs.fsync(tempPath);
    fs.rename(tempPath, path);
  } catch (err) {
    try {
      fs.remove(tempPath);
    } catch {
      /* best-effort cleanup only; must not mask the original failure */
    }
    throw new Error(`Failed to atomically write ${path}; the original file was left unchanged`, { cause: err });
  }
}

export interface WriteOwnedRegistrationInput {
  path: string;
  clientId: ClientId;
  /** The MMA entry to merge in at `mcpServers.mma`. Never include a static bearer
   *  token here — see the module doc's point 5. */
  entry: Record<string, unknown>;
  /** Test/advanced seam: overrides the real filesystem. */
  fs?: RegistrationFsDeps;
}

export interface OwnedRegistrationResult {
  path: string;
  changed: boolean;
}

/**
 * Merge `entry` into `path`'s `mcpServers.mma`, refusing rather than clobbering any
 * content this module cannot prove MMA owns. See the module doc for the full
 * discipline (ownership recognition, refuse-not-clobber, stale detection, atomic
 * rename, no static credential).
 */
export async function writeOwnedRegistration(input: WriteOwnedRegistrationInput): Promise<OwnedRegistrationResult> {
  const { path, clientId, entry } = input;
  const fs = input.fs ?? realFsDeps();
  assertNoStaticCredential(entry);

  const format = resolveFormat(clientId);
  assertSupportedFormat(clientId, format);

  const originalBytes = fs.readConfig(path);
  const { root, mcpServers } = parseJsonConfig(path, originalBytes);

  if (MMA_ENTRY_KEY in mcpServers && !isOwnedMcpEntry(mcpServers[MMA_ENTRY_KEY], format)) {
    throw new RegistrationConflictError(
      'unrecognised_entry',
      `Refusing to modify ${path}: "mcpServers.${MMA_ENTRY_KEY}" was not written by MMA. `
      + 'Remove or rename that entry yourself if you want MMA to manage it.',
    );
  }

  const nextRoot: Record<string, unknown> = { ...root, mcpServers: { ...mcpServers, [MMA_ENTRY_KEY]: entry } };
  const nextBytes = serializeJsonConfig(nextRoot);
  if (originalBytes !== undefined && originalBytes.equals(nextBytes)) {
    return { path, changed: false };
  }

  assertBytesUnchanged(fs, path, originalBytes);
  atomicWriteBytes(fs, path, nextBytes);
  return { path, changed: true };
}

export interface RemoveOwnedRegistrationInput {
  path: string;
  clientId: ClientId;
  fs?: RegistrationFsDeps;
}

/**
 * Remove `mcpServers.mma` from `path` and nothing else. Applies the SAME ownership
 * recogniser as {@link writeOwnedRegistration}, so it can never delete a hand-written
 * entry that a write would have refused to overwrite.
 */
export async function removeOwnedRegistration(input: RemoveOwnedRegistrationInput): Promise<OwnedRegistrationResult> {
  const { path, clientId } = input;
  const fs = input.fs ?? realFsDeps();

  const format = resolveFormat(clientId);
  assertSupportedFormat(clientId, format);

  const originalBytes = fs.readConfig(path);
  const { root, mcpServers } = parseJsonConfig(path, originalBytes);

  if (originalBytes === undefined || !(MMA_ENTRY_KEY in mcpServers)) {
    return { path, changed: false };
  }
  if (!isOwnedMcpEntry(mcpServers[MMA_ENTRY_KEY], format)) {
    throw new RegistrationConflictError(
      'unrecognised_entry',
      `Refusing to modify ${path}: "mcpServers.${MMA_ENTRY_KEY}" was not written by MMA. `
      + 'Remove or rename that entry yourself if you want MMA to manage it.',
    );
  }

  const remaining = { ...mcpServers };
  delete remaining[MMA_ENTRY_KEY];
  const nextBytes = serializeJsonConfig({ ...root, mcpServers: remaining });

  assertBytesUnchanged(fs, path, originalBytes);
  atomicWriteBytes(fs, path, nextBytes);
  return { path, changed: true };
}
