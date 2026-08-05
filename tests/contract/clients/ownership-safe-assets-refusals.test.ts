// Extra refusal-path coverage for the ownership-safe provisioning primitives beyond
// the plan-authored acceptance test (tests/contract/clients/ownership-safe-assets.test.ts),
// which only exercises a digest-mismatch skill conflict and an unowned registration
// entry. This file covers the remaining refusal paths named in Task I-4: a
// concurrent (stale) write, an absent skill marker, an unparseable skill marker, a
// stale-but-owned release, a fresh (unowned) install target, ownership-guarded
// removal, and the no-static-bearer-token invariant.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeSkillDigest, inspectSkillOwnership } from '../../../packages/server/src/provisioning/owned-files.js';
import type { AtomicFsDeps } from '../../../packages/server/src/provisioning/atomic-write.js';
import {
  RegistrationConflictError,
  isOwnedMcpEntry,
  removeOwnedRegistration,
  writeOwnedRegistration,
} from '../../../packages/server/src/provisioning/registration-writer.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mma-owned-assets-refusals-'));
}

describe('contract: ownership-safe provisioning assets — additional refusal paths', () => {
  it('reports unowned for a skill directory that does not exist yet', async () => {
    const root = await tempDir();
    const rendered = new Map([['SKILL.md', Buffer.from('skill')]]);
    const inspection = await inspectSkillOwnership(join(root, 'not-installed-yet'), rendered, '5.17.0');
    expect(inspection.state).toBe('unowned');
    expect(inspection.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports modified-conflict when the ownership marker is entirely absent', async () => {
    const root = await tempDir();
    const rendered = new Map([['SKILL.md', Buffer.from('skill')]]);
    // Directory exists (mkdtemp created it) but carries no .mma-install.json at all.
    const inspection = await inspectSkillOwnership(root, rendered, '5.17.0');
    expect(inspection.state).toBe('modified-conflict');
    expect(inspection.reason).toMatch(/missing/i);
  });

  it('reports modified-conflict when regular files no longer match the owned render', async () => {
    const root = await tempDir();
    const rendered = new Map([['SKILL.md', Buffer.from('original skill')]]);
    await writeFile(join(root, 'SKILL.md'), 'user edit');
    await writeFile(
      join(root, '.mma-install.json'),
      JSON.stringify({ release: '5.17.0', sha256: computeSkillDigest(rendered) }),
    );

    const inspection = await inspectSkillOwnership(root, rendered, '5.17.0');
    expect(inspection).toMatchObject({ state: 'modified-conflict' });
    expect(inspection.reason).toMatch(/modified/i);
  });

  it('reports modified-conflict when the ownership marker is not valid JSON', async () => {
    const root = await tempDir();
    const rendered = new Map([['SKILL.md', Buffer.from('skill')]]);
    await writeFile(join(root, '.mma-install.json'), 'not json');
    const inspection = await inspectSkillOwnership(root, rendered, '5.17.0');
    expect(inspection.state).toBe('modified-conflict');
  });

  it('reports owned-stale (not a conflict) when the recorded release differs from the installed one', async () => {
    const root = await tempDir();
    const rendered = new Map([['SKILL.md', Buffer.from('skill')]]);
    // The recorded digest need not match the CURRENT render — it is trusted for its
    // own (superseded) release, which this function has no way to re-render.
    await writeFile(join(root, '.mma-install.json'), JSON.stringify({ release: '5.16.0', sha256: '1'.repeat(64) }));
    const inspection = await inspectSkillOwnership(root, rendered, '5.17.0');
    expect(inspection.state).toBe('owned-stale');
    expect(inspection.recordedRelease).toBe('5.16.0');
  });

  it('excludes .mma-install.json itself and ignores rendered-map ordering when computing the digest', () => {
    const files = new Map([
      ['SKILL.md', Buffer.from('skill')],
      ['nested/a.txt', Buffer.from('a')],
      ['.mma-install.json', Buffer.from('{"release":"x","sha256":"y"}')],
    ]);
    const reordered = new Map([
      ['nested/a.txt', Buffer.from('a')],
      ['.mma-install.json', Buffer.from('{"different":"marker"}')],
      ['SKILL.md', Buffer.from('skill')],
    ]);
    expect(computeSkillDigest(files)).toBe(computeSkillDigest(reordered));
  });

  it('refuses a write when the config changes on disk between read and write (stale bytes)', async () => {
    const root = await tempDir();
    const config = join(root, 'config.json');
    const first = JSON.stringify({ mcpServers: {} });
    const concurrentSave = JSON.stringify({ mcpServers: {}, userPreference: 'added-while-we-were-writing' });
    let reads = 0;
    const fs: AtomicFsDeps = {
      readConfig: () => Buffer.from(++reads === 1 ? first : concurrentSave),
      createTemp: (path) => `${path}.tmp-test`,
      write: () => {},
      fsync: () => {},
      rename: () => {
        throw new Error('rename must never be reached once a stale read is detected');
      },
      remove: () => {},
    };
    await expect(
      writeOwnedRegistration({ path: config, clientId: 'cursor', entry: { url: 'http://127.0.0.1:7337/mcp' }, fs }),
    ).rejects.toMatchObject({ code: 'registration_conflict', reason: 'stale_bytes' });
  });

  it('writes a fresh, ownership-recognisable entry through atomic temp-file + rename', async () => {
    const root = await tempDir();
    const config = join(root, 'config.json');
    const result = await writeOwnedRegistration({
      path: config,
      clientId: 'cursor',
      entry: { url: 'http://127.0.0.1:7337/mcp' },
    });
    expect(result.changed).toBe(true);
    const written = JSON.parse(await readFile(config, 'utf8'));
    expect(written.mcpServers.mma.url).toBe('http://127.0.0.1:7337/mcp');

    // A second write of MMA's own entry is recognised as owned and succeeds cleanly.
    const second = await writeOwnedRegistration({
      path: config,
      clientId: 'cursor',
      entry: { url: 'http://127.0.0.1:7337/mcp' },
    });
    expect(second.changed).toBe(false);
  });

  it('removes only a recognised MMA entry and refuses to remove an unowned one', async () => {
    const root = await tempDir();
    const owned = join(root, 'owned.json');
    await writeFile(owned, JSON.stringify({ mcpServers: { mma: { url: 'http://127.0.0.1:7337/mcp' } } }));
    const removed = await removeOwnedRegistration({ path: owned, clientId: 'cursor' });
    expect(removed.changed).toBe(true);
    expect(JSON.parse(await readFile(owned, 'utf8')).mcpServers.mma).toBeUndefined();

    const foreign = join(root, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ mcpServers: { mma: { url: 'https://not-mma.example/mcp' } } }));
    await expect(removeOwnedRegistration({ path: foreign, clientId: 'cursor' })).rejects.toBeInstanceOf(RegistrationConflictError);
    expect(await readFile(foreign, 'utf8')).toContain('not-mma.example');
  });

  it('never persists a static bearer token, whatever client is asked to receive it', async () => {
    const root = await tempDir();
    const config = join(root, 'config.json');
    await expect(
      writeOwnedRegistration({
        path: config,
        clientId: 'cursor',
        entry: { url: 'http://127.0.0.1:7337/mcp', headers: { Authorization: `Bearer ${'a'.repeat(32)}` } },
      }),
    ).rejects.toMatchObject({ code: 'registration_conflict', reason: 'static_credential' });
    await expect(
      writeOwnedRegistration({
        path: config,
        clientId: 'cursor',
        entry: { url: 'http://127.0.0.1:7337/mcp', headers: { Authorization: 'Bearer short-token' } },
      }),
    ).rejects.toMatchObject({ code: 'registration_conflict', reason: 'static_credential' });
  });

  it('does not mistake an arbitrary stdio launcher for MMA ownership', () => {
    // The real Desktop entry is { command: <node>, args: [<entrypoint>, 'mcp'] }.
    // Ownership recognition gates whether MMA may OVERWRITE what it finds, so it
    // must recognise that exact shape and nothing looser: every near-miss below
    // is preserved rather than clobbered.
    const entrypoint = '/opt/mma/dist/cli/index.js';
    const owned = (entry: Record<string, unknown>) => isOwnedMcpEntry(entry, 'stdio-json', entrypoint);

    // Recognised — MMA's own entry, so re-registration can update it in place.
    expect(owned({ command: '/usr/bin/node', args: [entrypoint, 'mcp'] })).toBe(true);

    // A DIFFERENT tool's stdio MCP server. Shape-identical to ours, so nothing but
    // the entrypoint distinguishes it — this is the case that makes the entrypoint
    // check load-bearing rather than decorative.
    expect(owned({ command: '/usr/bin/node', args: ['/opt/other-tool.js', 'mcp'] })).toBe(false);
    // No `command` at all: not a usable stdio entry, so ownership is unprovable.
    expect(owned({ args: [entrypoint, 'mcp'] })).toBe(false);
    // Right shape, but carrying a key no MMA writer emits — someone else edited it.
    expect(owned({ command: '/usr/bin/node', args: [entrypoint, 'mcp'], env: {} })).toBe(false);
    // Not launching the bridge subcommand.
    expect(owned({ command: '/usr/bin/node', args: [entrypoint, 'serve'] })).toBe(false);
    // Relative paths are never MMA's — it always writes absolute ones.
    expect(owned({ command: 'node', args: ['cli/index.js', 'mcp'] })).toBe(false);

    // Fail closed: with no expected entrypoint supplied, ownership cannot be proven
    // even for a byte-perfect MMA entry, so the caller preserves rather than clobbers.
    expect(isOwnedMcpEntry({ command: '/usr/bin/node', args: [entrypoint, 'mcp'] }, 'stdio-json')).toBe(false);
  });
});
