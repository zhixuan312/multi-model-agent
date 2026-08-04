/**
 * Ownership-safe MCP registration writer.
 *
 * A client's MCP config file (`~/.cursor/mcp.json`, `claude_desktop_config.json`,
 * `~/.codex/config.toml`, ...) belongs to the USER: alongside whatever MMA writes,
 * it can hold entries for other MCP servers the user configured by hand. This
 * module generalises the discipline originally proven for Claude Desktop's legacy
 * writer (retired by Task I-5 in favour of `provisioning/writers/claude-desktop.ts`)
 * into one seam every writer can share, rather than each writer re-inventing it:
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
 *   4. **Write via temp file + fsync + atomic rename.** Supplied by
 *      `atomic-write.ts`, which the marker store shares — see that module.
 *   5. **Never persist a static bearer token.** A caller-provided entry containing
 *      an `Authorization: Bearer <token>`-shaped literal is refused outright — the
 *      only credential mechanisms allowed are dynamic ones (env/file interpolation,
 *      a helper script) supplied by the specific writer, never a baked-in secret.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { atomicWriteBytes, realFsDeps, type AtomicFsDeps } from './atomic-write.js';
import { CLIENT_CAPABILITIES, type ClientCapability, type McpConfigFormat } from './capability-registry.js';

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

/** The single MCP server name every writer targets inside `mcpServers`. */
const MMA_ENTRY_KEY = 'mma';

/**
 * Matches only a loopback URL pointing at MMA's own MCP endpoint — the exact shape
 * every HTTP-style writer renders.
 *
 * The port is deliberately unconstrained, and that is a trade-off worth naming.
 * `server.port` is user-configurable, so pinning ownership to the CURRENT port
 * would make MMA stop recognising its own entry the moment someone changed that
 * setting — it would then refuse to update the entry it wrote itself, and the user
 * would have to delete it by hand. Accepting any port keeps upgrades working
 * across a port change. The cost is that a hand-written entry which is
 * simultaneously named `mma`, carries only keys MMA writers emit, and points at a
 * DIFFERENT loopback `/mcp` service would be misread as ours. That conjunction is
 * narrow enough to accept; host and path are still pinned exactly.
 */
const LOOPBACK_MCP_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mcp$/;

/** Matches a literal bearer value wherever it appears in a serialized entry. Dynamic
 *  `${VAR}` and `{env:VAR}` / `{file:path}` substitutions remain allowed because
 *  the client resolves them at connection time rather than serializing a secret. */
const STATIC_BEARER_TOKEN_PATTERN = /Bearer\s+(?!\$\{[^}]+\}|\{(?:env|file):[^}]+\})[^\s"\\]+/;

function isAbsolutePathLike(candidate: string): boolean {
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

/** The CLI entrypoint a stdio entry launches — `args[0]` of `{command, args:[entrypoint,'mcp']}`.
 *  Returns undefined for any other shape, which makes ownership unprovable. */
function stdioEntrypointOf(entry: Record<string, unknown>): string | undefined {
  const args = entry.args;
  if (!Array.isArray(args)) return undefined;
  const first = args[0];
  return typeof first === 'string' ? first : undefined;
}

/**
 * Is this `mcpServers.mma` (or equivalent) value an entry MMA itself wrote?
 *
 * Dispatches on the client's `mcpConfigFormat`:
 *  - `stdio-json` (the Claude Desktop bridge shape): exactly `{command, args}`;
 *    `args` ends with `"mcp"`, and both the Node command and resolved CLI
 *    entrypoint are absolute paths.
 *  - every other supported format (`json`, `plugin-json`): key set ⊆
 *    `{url, serverUrl, headers, env}` and the URL is exactly MMA's own loopback
 *    `/mcp` endpoint.
 */
export function isOwnedMcpEntry(
  value: unknown,
  format: McpConfigFormat,
  expectedStdioEntrypoint?: string,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;

  if (format === 'stdio-json') {
    // A stdio entry carries no URL, so the loopback check below cannot serve as its
    // ownership proof. Its equivalent is the entrypoint: the entry is MMA's only if
    // it launches THIS installation's CLI. Without an expected entrypoint to compare
    // against, ownership is unprovable and we fail closed — shape alone would let
    // any `node /some/other-tool.js mcp` entry be mistaken for ours and overwritten.
    if (expectedStdioEntrypoint === undefined) return false;
    for (const key of Object.keys(entry)) {
      if (key !== 'command' && key !== 'args') return false;
    }
    const args = entry.args;
    // Exactly `[entrypoint, 'mcp']` — no more. A `>= 2` check would accept
    // `[entrypoint, '--inspect', 'mcp']`, i.e. an entry a user hand-edited to add
    // their own flag, and treat it as ours to overwrite or delete. Extra
    // arguments are exactly the evidence that somebody else edited this entry.
    if (!Array.isArray(args) || args.length !== 2) return false;
    if (args[1] !== 'mcp') return false;
    const first = args[0];
    return Object.keys(entry).length === 2
      && typeof entry.command === 'string'
      && isAbsolutePathLike(entry.command)
      && typeof first === 'string'
      && isAbsolutePathLike(first)
      && first === expectedStdioEntrypoint
      ;
  }

  // Superset across every non-stdio writer's own shape: claude-code's plugin entry
  // additionally carries `type`/`headersHelper`, codex's TOML entry carries
  // `bearer_token_env_var`, opencode's remote entry carries `type`/`enabled`. The
  // loopback URL check below remains the authoritative proof of ownership; this
  // set only guards against an entry carrying an unexpected key no MMA writer
  // would ever emit.
  const allowedKeys = new Set(['url', 'serverUrl', 'headers', 'env', 'type', 'headersHelper', 'bearer_token_env_var', 'enabled']);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) return false;
  }
  const url = entry.url ?? entry.serverUrl;
  return typeof url === 'string' && LOOPBACK_MCP_URL.test(url);
}

function resolveCapability(clientId: ClientId): ClientCapability {
  const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === clientId);
  if (!capability) {
    throw new RegistrationConflictError('unsupported_format', `No capability registry row for client '${clientId}'.`);
  }
  return capability;
}

function resolveFormat(clientId: ClientId): McpConfigFormat {
  return resolveCapability(clientId).mcpConfigFormat;
}

/** The key a client's registration file nests its MCP servers under. Defaults to
 *  `mcpServers` -- every writer but opencode uses that default; opencode verified
 *  its own servers live under a top-level `mcp` key instead (see the capability
 *  registry's `mcpTopLevelKey`). Resolving this from the registry, rather than
 *  hardcoding `mcpServers` here, is what lets opencode share this ONE install
 *  path instead of forking a second one. */
function resolveTopLevelKey(clientId: ClientId): string {
  return resolveCapability(clientId).mcpTopLevelKey ?? 'mcpServers';
}

function assertSupportedFormat(clientId: ClientId, format: McpConfigFormat): void {
  if (format !== 'json' && format !== 'plugin-json' && format !== 'stdio-json') {
    throw new RegistrationConflictError(
      'unsupported_format',
      `writeOwnedRegistration does not yet support the '${format}' format needed for '${clientId}'.`,
    );
  }
}

export function assertNoStaticCredential(entry: unknown): void {
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
 *  servers map reports its own type rather than being silently replaced.
 *  `topLevelKey` is the client-specific nesting key resolved by {@link
 *  resolveTopLevelKey} — `mcpServers` for every writer but opencode, which
 *  verified its servers live under `mcp` instead. */
function parseJsonConfig(path: string, bytes: Buffer | undefined, topLevelKey: string): ParsedJsonConfig {
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
  if (topLevelKey in root) {
    const raw = root[topLevelKey];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RegistrationConflictError('invalid_config', `Refusing to modify ${path}: "${topLevelKey}" is ${describeJsonType(raw)}, expected an object.`);
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
export function assertBytesUnchanged(fs: AtomicFsDeps, path: string, expected: Buffer | undefined): void {
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

export interface WriteOwnedRegistrationInput {
  path: string;
  clientId: ClientId;
  /** The MMA entry to merge in at `mcpServers.mma`. Never include a static bearer
   *  token here — see the module doc's point 5. */
  entry: Record<string, unknown>;
  /** Test/advanced seam: overrides the real filesystem. */
  fs?: AtomicFsDeps;
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
  const topLevelKey = resolveTopLevelKey(clientId);

  const originalBytes = fs.readConfig(path);
  const { root, mcpServers } = parseJsonConfig(path, originalBytes, topLevelKey);

  // For stdio, the entry MMA is about to write IS the ownership yardstick: an
  // existing entry is ours only if it launches the same entrypoint.
  const expectedStdioEntrypoint = stdioEntrypointOf(entry);

  if (MMA_ENTRY_KEY in mcpServers && !isOwnedMcpEntry(mcpServers[MMA_ENTRY_KEY], format, expectedStdioEntrypoint)) {
    throw new RegistrationConflictError(
      'unrecognised_entry',
      `Refusing to modify ${path}: "${topLevelKey}.${MMA_ENTRY_KEY}" was not written by MMA. `
      + 'Remove or rename that entry yourself if you want MMA to manage it.',
    );
  }

  const nextRoot: Record<string, unknown> = { ...root, [topLevelKey]: { ...mcpServers, [MMA_ENTRY_KEY]: entry } };
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
  /** Required for `stdio-json` clients: the CLI entrypoint this installation
   *  launches. Removal must prove ownership just as strictly as writing does, and
   *  a stdio entry's only proof is that it launches THIS entrypoint. Omitting it
   *  makes ownership unprovable, so the entry is preserved rather than removed. */
  expectedStdioEntrypoint?: string;
  fs?: AtomicFsDeps;
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
  const topLevelKey = resolveTopLevelKey(clientId);

  const originalBytes = fs.readConfig(path);
  const { root, mcpServers } = parseJsonConfig(path, originalBytes, topLevelKey);

  if (originalBytes === undefined || !(MMA_ENTRY_KEY in mcpServers)) {
    return { path, changed: false };
  }
  if (!isOwnedMcpEntry(mcpServers[MMA_ENTRY_KEY], format, input.expectedStdioEntrypoint)) {
    throw new RegistrationConflictError(
      'unrecognised_entry',
      `Refusing to modify ${path}: "${topLevelKey}.${MMA_ENTRY_KEY}" was not written by MMA. `
      + 'Remove or rename that entry yourself if you want MMA to manage it.',
    );
  }

  const remaining = { ...mcpServers };
  delete remaining[MMA_ENTRY_KEY];
  const nextBytes = serializeJsonConfig({ ...root, [topLevelKey]: remaining });

  assertBytesUnchanged(fs, path, originalBytes);
  atomicWriteBytes(fs, path, nextBytes);
  return { path, changed: true };
}

/**
 * Per-client registration writers (Task I-5/I-6).
 *
 * Everything above this point is the shared, format-generic ownership/stale/
 * atomic-rename/no-static-credential machinery. Everything below dispatches to
 * the client-specific writer that renders each client's own recognised entry
 * shape and installs it through that machinery — selected by the capability
 * registry, never a hand-maintained target switch.
 */

/** The result every per-client writer (install or remove) returns — one shape
 *  shared across `packages/server/src/provisioning/writers/*`. */
export type ClientRegistrationStatus = 'registered' | 'absent' | 'failed';

export interface ClientRegistrationResult {
  status: ClientRegistrationStatus;
  path: string;
  clientId: ClientId;
  /** Whether this call actually changed the file on disk (`false` for an
   *  already-correct idempotent write, or a remove that found nothing to remove). */
  changed: boolean;
  conflictReason?: RegistrationConflictReason;
  message?: string;
  /**
   * Structural self-check that the just-written (or already-registered) entry is
   * complete enough for a FRESH adapter to connect without retry. This is
   * deliberately NOT a live network/process handshake — the daemon may not even be
   * running yet at provisioning time — only a proof that the rendered entry itself
   * is internally consistent (see {@link assertInitializable}).
   */
  initializeOnce(): Promise<{ ok: true }>;
}

export interface WriteClientRegistrationInput {
  capability: ClientCapability;
  /** Absolute home directory every writer resolves its user-level config path from. */
  homeDir: string;
  /** Daemon port for HTTP-style writers. Ignored by the stdio bridge (Claude Desktop). */
  daemonPort: number;
  /** Absolute path of the CLI entrypoint the stdio bridge launches (Claude Desktop only). */
  cliEntrypoint: string;
  /** Absolute path of the Node binary that launches the stdio bridge. Defaults to
   *  `process.execPath`. */
  execPath?: string;
  /** `process.platform`, overridable for Claude Desktop's macOS/Windows path split. */
  platform?: string;
  /** Windows APPDATA root for Claude Desktop's user-level configuration. */
  appData?: string;
  /** Test/advanced seam: overrides the real filesystem for every writer this input reaches. */
  fs?: AtomicFsDeps;
}

/** Uniform failure mapping: an error from ANY writer (a refused conflict or an
 *  unexpected I/O failure alike) becomes a `failed` result rather than a thrown
 *  exception — matching the Contract's "returns failed without clobbering user
 *  content" rather than raising past the caller. */
export function failedClientRegistrationResult(clientId: ClientId, path: string, err: unknown): ClientRegistrationResult {
  const message = err instanceof Error ? err.message : String(err);
  const conflictReason = err instanceof RegistrationConflictError ? err.reason : undefined;
  return {
    status: 'failed',
    path,
    clientId,
    changed: false,
    conflictReason,
    message,
    async initializeOnce() {
      throw err instanceof Error ? err : new Error(message);
    },
  };
}

/**
 * Structural completeness check every writer's `initializeOnce()` delegates to.
 * Proves the rendered entry has whatever a fresh client adapter needs to connect —
 * an absolute stdio command + args for the bridge shape, or a non-empty loopback
 * URL for every HTTP-style shape (including codex's TOML, whose entry is a plain
 * `{url, ...}` record by the time it reaches this check).
 */
export function assertInitializable(entry: Record<string, unknown>, format: McpConfigFormat): void {
  if (format === 'stdio-json') {
    if (typeof entry.command !== 'string' || entry.command === '') {
      throw new Error('Claude Desktop entry is missing a usable "command".');
    }
    if (!Array.isArray(entry.args) || entry.args.length < 2 || entry.args[entry.args.length - 1] !== 'mcp') {
      throw new Error('Claude Desktop entry is missing a usable "args" ending in "mcp".');
    }
    return;
  }
  const url = entry.url ?? entry.serverUrl;
  if (typeof url !== 'string' || url === '') {
    throw new Error(`Registration entry is missing a usable url/serverUrl for format '${format}'.`);
  }
}

/**
 * Shared install path for every writer whose format merges as JSON (`json`,
 * `plugin-json`, `stdio-json`) through {@link writeOwnedRegistration}. Codex's
 * `toml` format cannot go through this — see `writers/codex.ts`, which reuses the
 * same atomic-rename/stale-check/no-static-credential primitives directly.
 */
export async function installJsonClientRegistration(params: {
  capability: ClientCapability;
  path: string;
  entry: Record<string, unknown>;
  fs?: AtomicFsDeps;
}): Promise<ClientRegistrationResult> {
  const { capability, path, entry, fs } = params;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const written = await writeOwnedRegistration({ path, clientId: capability.id, entry, fs });
    assertInitializable(entry, capability.mcpConfigFormat);
    return {
      status: 'registered',
      path,
      clientId: capability.id,
      changed: written.changed,
      async initializeOnce() {
        assertInitializable(entry, capability.mcpConfigFormat);
        return { ok: true };
      },
    };
  } catch (err) {
    return failedClientRegistrationResult(capability.id, path, err);
  }
}

/** Shared remove path, symmetric with {@link installJsonClientRegistration}. */
export async function removeJsonClientRegistration(params: {
  capability: ClientCapability;
  path: string;
  /** Required for `stdio-json` clients — see {@link RemoveOwnedRegistrationInput}. */
  expectedStdioEntrypoint?: string;
  fs?: AtomicFsDeps;
}): Promise<ClientRegistrationResult> {
  const { capability, path, fs } = params;
  try {
    const removed = await removeOwnedRegistration({
      path,
      clientId: capability.id,
      ...(params.expectedStdioEntrypoint !== undefined && { expectedStdioEntrypoint: params.expectedStdioEntrypoint }),
      fs,
    });
    return {
      status: 'absent',
      path,
      clientId: capability.id,
      changed: removed.changed,
      async initializeOnce() {
        throw new Error(`'${capability.id}' has no registration to initialize after removal.`);
      },
    };
  } catch (err) {
    return failedClientRegistrationResult(capability.id, path, err);
  }
}

// Deferred import: each writer below imports primitives FROM this module (the
// shared ownership-safe machinery), and this module imports the writer function
// TO dispatch by capability — a standard, safe ESM cycle since nothing here is
// evaluated at either module's top level, only inside function bodies called
// after the whole graph has finished loading.
import { claudeCodeRegistrationPath, writeClaudeCodeRegistration } from './writers/claude-code.js';
import { removeClaudeDesktopRegistration, writeClaudeDesktopRegistration } from './writers/claude-desktop.js';
import { codexRegistrationPath, removeCodexRegistration, writeCodexRegistration } from './writers/codex.js';
import { antigravityRegistrationPath, writeAntigravityRegistration } from './writers/antigravity.js';
import { cursorRegistrationPath, writeCursorRegistration } from './writers/cursor.js';
import { opencodeRegistrationPath, writeOpencodeRegistration } from './writers/opencode.js';
import { windsurfRegistrationPath, writeWindsurfRegistration } from './writers/windsurf.js';

const UNBLOCKED_WRITERS: Partial<Record<ClientId, (input: WriteClientRegistrationInput) => Promise<ClientRegistrationResult>>> = {
  'claude-code': writeClaudeCodeRegistration,
  'claude-desktop': writeClaudeDesktopRegistration,
  codex: writeCodexRegistration,
  antigravity: writeAntigravityRegistration,
  cursor: writeCursorRegistration,
  opencode: writeOpencodeRegistration,
  windsurf: writeWindsurfRegistration,
};

/** Every non-stdio writer's remove path is the same shared JSON removal
 *  machinery, just pointed at that writer's own resolved path -- no
 *  per-client removal logic beyond "where is the file". */
function jsonRemover(resolvePath: (homeDir: string) => string): (input: WriteClientRegistrationInput) => Promise<ClientRegistrationResult> {
  return (input) => removeJsonClientRegistration({ capability: input.capability, path: resolvePath(input.homeDir), fs: input.fs });
}

const UNBLOCKED_REMOVERS: Partial<Record<ClientId, (input: WriteClientRegistrationInput) => Promise<ClientRegistrationResult>>> = {
  'claude-code': jsonRemover(claudeCodeRegistrationPath),
  'claude-desktop': removeClaudeDesktopRegistration,
  codex: removeCodexRegistration,
  antigravity: jsonRemover(antigravityRegistrationPath),
  cursor: jsonRemover(cursorRegistrationPath),
  opencode: jsonRemover(opencodeRegistrationPath),
  windsurf: jsonRemover(windsurfRegistrationPath),
};

/**
 * Install `capability`'s recognised home-level MMA MCP entry by dispatching to its
 * registered writer — the registry (`UNBLOCKED_WRITERS`), not a target switch,
 * selects which one runs. A client with no writer yet (Task I-6's VS Code,
 * opencode, Windsurf) returns `failed` rather than throwing.
 */
export async function writeClientRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const writer = UNBLOCKED_WRITERS[input.capability.id];
  if (!writer) {
    return failedClientRegistrationResult(
      input.capability.id,
      '',
      new Error(`No registration writer is available yet for client '${input.capability.id}'.`),
    );
  }
  return writer(input);
}

/**
 * The registered writer function for `clientId`, or `undefined` when none exists
 * yet — the checkable signal Task I-6's evidence gate relies on. A client stays
 * writer-less until its profile in `docs/verification/
 * mcp-client-registration-profiles.md` is VERIFIED; `vscode` remains undefined
 * here because its profile is still BLOCKED (see the capability registry's
 * `mcpConfigPaths: []` for the same signal from the other direction).
 */
export function writerForClient(
  clientId: ClientId,
): ((input: WriteClientRegistrationInput) => Promise<ClientRegistrationResult>) | undefined {
  return UNBLOCKED_WRITERS[clientId];
}

/** Remove the capability-selected registration when that writer supports removal. */
export async function removeClientRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const remover = UNBLOCKED_REMOVERS[input.capability.id];
  if (!remover) {
    return failedClientRegistrationResult(
      input.capability.id,
      '',
      new Error(`No registration remover is available yet for client '${input.capability.id}'.`),
    );
  }
  return remover(input);
}
