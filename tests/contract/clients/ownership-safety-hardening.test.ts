/**
 * The ownership proof must be a proof, not a resemblance.
 *
 * Each case below is a way a skill directory can LOOK owned while MMA has in fact
 * proven nothing about it. They exist because a pre-merge review found two of them
 * live: a symlinked SKILL.md was silently excluded from the digest (so an emptied
 * file set still matched its marker, and the subsequent write followed the link
 * clean out of the skill root), and a marker naming any other release was accepted
 * on its own word with no reference to the bytes actually on disk.
 *
 * What makes these worth pinning: in every case the failure is silent and
 * destructive. Nothing errors, nothing warns — MMA simply overwrites or deletes
 * content it does not own.
 */
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSkillDigest,
  inspectSkillOwnership,
  readInstalledRegularFiles,
  UnprovableSkillEntryError,
} from '../../../packages/server/src/provisioning/owned-files.js';
import { isOwnedMcpEntry } from '../../../packages/server/src/provisioning/registration-writer.js';

const RELEASE = '5.17.0';
const RENDERED = new Map([['SKILL.md', Buffer.from('the real skill body')]]);
const RENDERED_DIGEST = computeSkillDigest(RENDERED);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mma-ownership-hardening-'));
}

/** A directory exactly as a completed install of `release` leaves it. */
async function installedSkillDir(root: string, release = RELEASE, digest = RENDERED_DIGEST): Promise<string> {
  const dir = join(root, 'mma-audit');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), RENDERED.get('SKILL.md')!);
  await writeFile(join(dir, '.mma-install.json'), JSON.stringify({ release, sha256: digest }));
  return dir;
}

describe('contract: skill ownership cannot be faked', () => {
  it('refuses a directory whose file was swapped for a symlink, instead of hashing around it', async () => {
    const root = await tempDir();
    const victim = join(root, 'unrelated-user-file.txt');
    await writeFile(victim, 'content MMA has no business touching');

    const dir = await installedSkillDir(root);
    await rm(join(dir, 'SKILL.md'));
    await symlink(victim, join(dir, 'SKILL.md'));

    const inspection = await inspectSkillOwnership(dir, RENDERED, RELEASE);

    expect(inspection.state, 'a symlink makes ownership unprovable, not irrelevant').toBe('modified-conflict');
    expect(inspection.reason).toMatch(/symlink/);
    // The whole point: nothing downstream may write here, so the link's target is safe.
    expect(await readFile(victim, 'utf8')).toBe('content MMA has no business touching');
  });

  it('refuses a marker that is itself a symlink', async () => {
    const root = await tempDir();
    const elsewhere = join(root, 'planted-marker.json');
    await writeFile(elsewhere, JSON.stringify({ release: RELEASE, sha256: RENDERED_DIGEST }));

    const dir = join(root, 'mma-audit');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), RENDERED.get('SKILL.md')!);
    await symlink(elsewhere, join(dir, '.mma-install.json'));

    expect((await inspectSkillOwnership(dir, RENDERED, RELEASE)).state).toBe('modified-conflict');
  });

  it('surfaces a non-regular entry as a typed error rather than dropping it from the walk', async () => {
    const root = await tempDir();
    const dir = join(root, 'mma-audit');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), 'body');
    await symlink(join(root, 'anything'), join(dir, 'dangling'));

    await expect(readInstalledRegularFiles(dir)).rejects.toBeInstanceOf(UnprovableSkillEntryError);
  });

  it('verifies a stale-release directory against the digest that release recorded', async () => {
    const root = await tempDir();
    // A prior release's install: content and marker agree, just not with THIS release.
    const intact = await installedSkillDir(root, '5.0.0', RENDERED_DIGEST);
    expect((await inspectSkillOwnership(intact, RENDERED, RELEASE)).state).toBe('owned-stale');

    // Same marker, content edited afterwards. Previously accepted on the marker's
    // word alone; the marker's own recorded digest is what disproves it.
    await writeFile(join(intact, 'SKILL.md'), 'the user edited this after installing');
    const edited = await inspectSkillOwnership(intact, RENDERED, RELEASE);
    expect(edited.state).toBe('modified-conflict');
    expect(edited.reason).toMatch(/5\.0\.0/);
  });

  it('refuses user content wearing a hand-written stale marker', async () => {
    const root = await tempDir();
    const dir = join(root, 'mma-audit');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), 'a user wrote this skill themselves');
    await writeFile(join(dir, '.mma-install.json'), JSON.stringify({ release: '0.0.1', sha256: 'fabricated' }));

    expect((await inspectSkillOwnership(dir, RENDERED, RELEASE)).state).toBe('modified-conflict');
  });

  it('still accepts an intact install of the running release', async () => {
    const root = await tempDir();
    const dir = await installedSkillDir(root);
    expect((await inspectSkillOwnership(dir, RENDERED, RELEASE)).state).toBe('owned');
  });
});

describe('contract: stdio entry ownership admits exactly one arg shape', () => {
  const owned = { command: '/usr/local/bin/node', args: ['/opt/mma.js', 'mcp'] };

  it('recognises the entry MMA writes', () => {
    expect(isOwnedMcpEntry(owned, 'stdio-json', '/opt/mma.js')).toBe(true);
  });

  it('refuses an entry a user added their own argument to', () => {
    // Same command, same entrypoint, still ends in 'mcp' — but the extra flag IS
    // the evidence somebody edited it, so it is not ours to overwrite or delete.
    const handEdited = { command: '/usr/local/bin/node', args: ['/opt/mma.js', '--inspect', 'mcp'] };
    expect(isOwnedMcpEntry(handEdited, 'stdio-json', '/opt/mma.js')).toBe(false);
  });

  it('refuses an entry launching a different tool', () => {
    expect(isOwnedMcpEntry({ command: '/usr/local/bin/node', args: ['/opt/other-tool.js', 'mcp'] }, 'stdio-json', '/opt/mma.js')).toBe(false);
  });

  it('refuses when there is no expected entrypoint to compare against', () => {
    expect(isOwnedMcpEntry(owned, 'stdio-json')).toBe(false);
  });
});
