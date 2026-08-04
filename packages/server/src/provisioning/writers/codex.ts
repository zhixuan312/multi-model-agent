/**
 * Codex registration writer.
 *
 * Codex's user-level config is TOML (`~/.codex/config.toml`), not JSON, so it
 * cannot go through {@link installJsonClientRegistration}'s JSON merge — but it
 * reuses the SAME underlying safety primitives (`../registration-writer.js`'s
 * `realFsDeps`/`atomicWriteBytes`/`assertBytesUnchanged`/`assertNoStaticCredential`,
 * plus the shared `isOwnedMcpEntry` ownership recogniser) so the discipline
 * (refuse-not-clobber, stale-bytes check, atomic rename, no static credential) is
 * identical, just applied to a `[mcp_servers.mma]` TOML table instead of a JSON
 * `mcpServers.mma` member.
 *
 * The credential mechanism is `bearer_token_env_var` — the NAME of an environment
 * variable Codex reads at connect time, never a literal token value — matching
 * the "no static credential" invariant this writer must uphold.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertBytesUnchanged,
  assertInitializable,
  assertNoStaticCredential,
  atomicWriteBytes,
  failedClientRegistrationResult,
  isOwnedMcpEntry,
  realFsDeps,
  RegistrationConflictError,
  type ClientRegistrationResult,
  type RegistrationFsDeps,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

/** The one table this writer owns. Codex's TOML allows any number of sibling
 *  `[mcp_servers.<other>]` tables and unrelated root keys (`model`, `[history]`,
 *  ...) — everything outside this table's own byte range is preserved verbatim. */
const TABLE_HEADER = '[mcp_servers.mma]';
const TABLE_HEADER_LINE_RE = /^\[mcp_servers\.mma\]\r?\n?/m;
const OWNED_TABLE_START_RE = /^\[mcp_servers\.mma\]\r?\n/m;
const NEXT_TABLE_HEADER_RE = /^\[/m;
const SIMPLE_STRING_KV_RE = /^([A-Za-z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;

function tomlStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderTable(entry: Record<string, string>): string {
  const lines = Object.entries(entry).map(([key, value]) => `${key} = ${tomlStringLiteral(value)}`);
  return `${TABLE_HEADER}\n${lines.join('\n')}\n`;
}

/** Parses a `[mcp_servers.mma]` table's content lines as flat `key = "value"`
 *  pairs. Returns `null` for ANY line this cannot safely reason about (a nested
 *  table, an array, a non-string scalar, ...) — refuse rather than guess, exactly
 *  like the JSON path's `parseJsonConfig` refuses a wrong-shaped `mcpServers`. */
function parseSimpleTomlTable(content: string): Record<string, string> | null {
  const record: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = SIMPLE_STRING_KV_RE.exec(line);
    if (!match) return null;
    const [, key, rawValue] = match;
    record[key] = rawValue.replace(/\\(.)/g, '$1');
  }
  return record;
}

/** Byte range of an EXISTING `[mcp_servers.mma]` table — from its header line up
 *  to (not including) the next top-level `[...]` header or EOF. `null` when no
 *  such table exists yet. */
function findOwnedTableRange(text: string): { start: number; end: number } | null {
  const headerMatch = OWNED_TABLE_START_RE.exec(text);
  if (!headerMatch) return null;
  const start = headerMatch.index;
  const contentStart = start + headerMatch[0].length;
  const rest = text.slice(contentStart);
  const nextHeaderMatch = NEXT_TABLE_HEADER_RE.exec(rest);
  const end = nextHeaderMatch ? contentStart + nextHeaderMatch.index : text.length;
  return { start, end };
}

async function writeOwnedTomlTable(path: string, entry: Record<string, string>, fs: RegistrationFsDeps): Promise<{ changed: boolean }> {
  assertNoStaticCredential(entry);

  const originalBytes = fs.readConfig(path);
  const originalText = originalBytes?.toString('utf8') ?? '';
  const range = findOwnedTableRange(originalText);

  let nextText: string;
  if (range) {
    const existingContent = originalText.slice(range.start, range.end).replace(TABLE_HEADER_LINE_RE, '');
    const parsed = parseSimpleTomlTable(existingContent);
    if (parsed === null || !isOwnedMcpEntry(parsed, 'toml')) {
      throw new RegistrationConflictError(
        'unrecognised_entry',
        `Refusing to modify ${path}: "${TABLE_HEADER}" was not written by MMA. `
        + 'Remove or rename that table yourself if you want MMA to manage it.',
      );
    }
    nextText = `${originalText.slice(0, range.start)}${renderTable(entry)}${originalText.slice(range.end)}`;
  } else {
    const separator = originalText.length === 0 ? '' : originalText.endsWith('\n') ? '\n' : '\n\n';
    nextText = `${originalText}${separator}${renderTable(entry)}`;
  }

  const nextBytes = Buffer.from(nextText, 'utf8');
  if (originalBytes !== undefined && originalBytes.equals(nextBytes)) {
    return { changed: false };
  }

  assertBytesUnchanged(fs, path, originalBytes);
  atomicWriteBytes(fs, path, nextBytes);
  return { changed: true };
}

export async function writeCodexRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = join(homeDir, '.codex', 'config.toml');
  const entry = {
    url: `http://127.0.0.1:${daemonPort}/mcp`,
    bearer_token_env_var: 'MMA_AUTH_TOKEN',
  };
  const fs = input.fs ?? realFsDeps();

  try {
    mkdirSync(dirname(path), { recursive: true });
    const written = await writeOwnedTomlTable(path, entry, fs);
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
