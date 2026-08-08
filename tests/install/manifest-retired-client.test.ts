/**
 * A retired client id must not brick skill sync.
 *
 * `targets` is validated against CLIENT_IDS, which is a living roster: `gemini`
 * became `antigravity` when Google folded Gemini CLI into Antigravity CLI. The
 * strict v2 validator treated a manifest naming the old id as structurally
 * invalid, so `listEntries()` threw — and because every sync path calls it,
 * skill synchronisation stopped for EVERY client on that machine, not just the
 * renamed one, with no message anywhere.
 *
 * Found on a real machine: a manifest with 16 entries targeting `codex` and
 * `gemini` had silently disabled skill sync entirely.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listEntries, manifestPath } from '../../packages/server/src/skill-install/manifest.js';

let home: string;

function writeManifest(entries: unknown[]): void {
  mkdirSync(join(home, '.mma'), { recursive: true });
  writeFileSync(manifestPath(home), JSON.stringify({ version: 2, entries }, null, 2));
}

const entry = (name: string, targets: string[]) => ({
  name, skillVersion: '6.4.0', installedAt: 1_700_000_000_000, targets,
});

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mma-manifest-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

it('drops a retired client id and keeps the rest of the entry', () => {
  writeManifest([entry('mma-audit', ['codex', 'gemini'])]);
  const entries = listEntries(home);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.targets).toEqual(['codex']);
});

it('does not throw, so skill sync keeps working for every other client', () => {
  writeManifest([entry('mma-audit', ['codex', 'gemini']), entry('mma-review', ['cursor'])]);
  expect(() => listEntries(home)).not.toThrow();
  expect(listEntries(home).map((e) => e.name)).toEqual(['mma-audit', 'mma-review']);
});

it('drops an entry whose only target no longer exists', () => {
  writeManifest([entry('mma-audit', ['gemini']), entry('mma-review', ['codex'])]);
  expect(listEntries(home).map((e) => e.name)).toEqual(['mma-review']);
});

// The repair is in-memory ONLY. Writing during a read would be wrong twice
// over: appendEntry/removeEntry are unlocked read-modify-write operations, so a
// repair racing one of them silently discards the other's changes; and on a
// read-only filesystem the write would throw out of what the caller invoked as
// a read, failing every consumer over a cosmetic cleanup.
it('does not write during a read', () => {
  writeManifest([entry('mma-audit', ['codex', 'gemini'])]);
  const before = readFileSync(manifestPath(home), 'utf-8');
  expect(listEntries(home)[0]?.targets).toEqual(['codex']); // caller sees it cleaned
  expect(readFileSync(manifestPath(home), 'utf-8')).toBe(before); // disk untouched
});

it('keeps working when the manifest cannot be written at all', () => {
  writeManifest([entry('mma-audit', ['codex', 'gemini'])]);
  chmodSync(manifestPath(home), 0o400); // read-only file
  try {
    expect(() => listEntries(home)).not.toThrow();
    expect(listEntries(home)[0]?.targets).toEqual(['codex']);
  } finally {
    chmodSync(manifestPath(home), 0o600);
  }
});

it('reports which ids were retired', () => {
  writeManifest([entry('mma-audit', ['codex', 'gemini'])]);
  const warnings: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    warnings.push(String(s)); return true;
  });
  listEntries(home);
  spy.mockRestore();
  expect(warnings.join('')).toContain('gemini');
  expect(warnings.join('')).toContain('mma sync-skills');
});

it('leaves a clean manifest completely alone', () => {
  writeManifest([entry('mma-audit', ['codex', 'cursor'])]);
  const before = readFileSync(manifestPath(home), 'utf-8');
  expect(listEntries(home)[0]?.targets).toEqual(['codex', 'cursor']);
  expect(readFileSync(manifestPath(home), 'utf-8')).toBe(before); // not rewritten
});

// The distinction that keeps this from becoming "swallow everything": an entry
// naming a client that no longer exists is recoverable by re-syncing. A
// malformed file is not something to guess at.
it('still throws on genuine structural damage', () => {
  writeManifest([{ name: 'mma-audit', skillVersion: 42, installedAt: 'yesterday', targets: ['codex'] }]);
  expect(() => listEntries(home)).toThrow();
});
