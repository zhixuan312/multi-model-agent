/**
 * The production port's destructive operations, exercised against a real
 * filesystem rather than the in-memory fake.
 *
 * `service.ts`'s fixture proves the ORCHESTRATION is right — which marker, which
 * phase, which order. It cannot prove the filesystem behaviour underneath, because
 * its port keeps skills in a Map. These are the cases where the difference matters:
 * every one of them ends in an `rmSync(..., {recursive: true})` or a write, against
 * a path that ultimately came from a marker file the running user can edit.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRealProvisioningPort } from '../../../packages/server/src/provisioning/real-port.js';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';

const RELEASE = '5.17.0';
const cursor = CLIENT_CAPABILITIES.find((c) => c.id === 'cursor')!;

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'mma-port-home-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'mma-port-state-'));
  const port = createRealProvisioningPort({
    homeDir: home,
    daemonPort: 7337,
    cliEntrypoint: '/opt/mma.js',
    release: RELEASE,
    stateDir,
  });
  return { home, stateDir, port, backupsRoot: join(stateDir, 'provisioning', 'skill-backups') };
}

describe('contract: the real port refuses destructive work it cannot justify', () => {
  it('will not delete outside its backups root, however the path is spelled', () => {
    const { stateDir, port, backupsRoot } = harness();
    // A marker is a plain JSON file under stateDir that the running user can edit,
    // and `priorSkillBackup` feeds a recursive delete.
    const outside = join(stateDir, 'not-a-backup');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep-me.txt'), 'important');
    // The backups root must really exist, or the kernel cannot resolve `..`
    // through it and the delete would be a harmless no-op for the wrong reason.
    mkdirSync(backupsRoot, { recursive: true });

    // Built by concatenation, NOT `join` — `join` normalises `..` away, which
    // would make even a naive prefix check pass and prove nothing. An unresolved
    // traversal is exactly what a hand-edited marker would contain.
    // Two levels up: backupsRoot is <stateDir>/provisioning/skill-backups.
    const traversal = `${backupsRoot}${sep}..${sep}..${sep}not-a-backup`;
    expect(traversal.startsWith(backupsRoot + sep), 'the string really does look contained').toBe(true);
    expect(resolve(traversal), 'and really does resolve to the protected path').toBe(resolve(outside));

    port.discardSkillBackup(traversal);
    expect(existsSync(join(outside, 'keep-me.txt')), 'traversal must not escape the backups root').toBe(true);

    port.discardSkillBackup(stateDir);
    expect(existsSync(outside), 'an unrelated path under stateDir is ignored too').toBe(true);
  });

  it('deletes a genuine backup it created', async () => {
    const { home, port, backupsRoot } = harness();
    await port.installSkills('cursor', cursor);
    const backup = await port.backupSkills('cursor', cursor);
    expect(backup.backupPath).not.toBeNull();
    expect(backup.backupPath!.startsWith(backupsRoot)).toBe(true);

    port.discardSkillBackup(backup.backupPath!);
    expect(existsSync(backup.backupPath!)).toBe(false);
    expect(port.installedSkillNames('cursor', cursor).length, 'the live skills are untouched').toBeGreaterThan(0);
    expect(home).toBeTruthy();
  });

  it('keeps live skills when the backup has been emptied since it was taken', async () => {
    const { port } = harness();
    await port.installSkills('cursor', cursor);
    const backup = await port.backupSkills('cursor', cursor);
    const installedBefore = port.installedSkillNames('cursor', cursor);
    expect(installedBefore.length).toBeGreaterThan(0);

    // The directory still exists, so an existence check passes — but restoring
    // from it would wipe every live skill and put back nothing.
    for (const name of readdirSync(backup.backupPath!)) {
      const { rmSync } = await import('node:fs');
      rmSync(join(backup.backupPath!, name), { recursive: true, force: true });
    }

    const result = await port.restoreSkills('cursor', cursor, backup.backupPath, backup.digest);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/digest/);
    expect(port.installedSkillNames('cursor', cursor), 'nothing was removed')
      .toEqual(installedBefore);
  });

  it('will not restore a registration onto a path the marker merely claims is this client\'s', async () => {
    const { stateDir, port } = harness();
    // The registry decides where cursor's registration lives. A marker is a file
    // the running user can edit, so its `path` is a claim, not an address — and it
    // feeds both a whole-file write and an unlink.
    const theirFile = join(stateDir, 'unrelated.json');
    writeFileSync(theirFile, JSON.stringify({ theirs: true }));
    const forged = {
      path: theirFile,
      existed: true,
      bytesBase64: Buffer.from('{"attacker":"bytes"}').toString('base64'),
    };

    // No post-mutation fingerprint, so the drift check cannot be what stops this.
    expect(port.isRegistrationReachable('cursor', cursor, forged, null)).toBe(false);
    const result = await port.restoreRegistration('cursor', cursor, forged);

    expect(result.ok).toBe(false);
    expect(readFileSync(theirFile, 'utf8'), 'the unrelated file is untouched')
      .toBe(JSON.stringify({ theirs: true }));
  });

  it('will not restore skills from a backup directory outside its backups root', async () => {
    const { port } = harness();
    await port.installSkills('cursor', cursor);
    const installedBefore = port.installedSkillNames('cursor', cursor);

    // A directory the attacker controls, with a digest computed over its OWN
    // contents — so the pair is self-consistent and the digest check passes.
    // Verifying the digest cannot help here: the digest and the path come out of
    // the same marker. Only the path's location tells them apart.
    const planted = mkdtempSync(join(tmpdir(), 'mma-port-planted-'));
    mkdirSync(join(planted, 'mma-audit'), { recursive: true });
    writeFileSync(join(planted, 'mma-audit', 'SKILL.md'), 'attacker content');
    const { computeSkillDigest } = await import('../../../packages/server/src/provisioning/owned-files.js');
    const plantedDigest = computeSkillDigest(new Map([['mma-audit/SKILL.md', Buffer.from('attacker content')]]));

    const result = await port.restoreSkills('cursor', cursor, planted, plantedDigest);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/backup directory/);
    expect(port.installedSkillNames('cursor', cursor), 'the live skills are untouched')
      .toEqual(installedBefore);
  });

  it('still installs into a skill ROOT that is a symlink', async () => {
    // The counterweight to rejecting a symlinked skill directory. Pointing
    // `~/.agents/skills` at a managed dotfiles checkout is an ordinary setup, and
    // it stays legitimate: the link is a path a skill directory lives UNDER, not a
    // path standing in for one. A guard that failed to tell those apart would
    // break a real workflow while claiming to be a safety improvement.
    const { symlinkSync } = await import('node:fs');
    const { home, port } = harness();
    const managed = mkdtempSync(join(tmpdir(), 'mma-port-dotfiles-'));
    mkdirSync(join(home, '.agents'), { recursive: true });
    symlinkSync(managed, join(home, '.agents', 'skills'));

    const result = await port.installSkills('cursor', cursor);

    expect(result.ok).toBe(true);
    expect(readdirSync(managed).length, 'the skills land inside the link target').toBeGreaterThan(0);
    expect(port.installedSkillNames('cursor', cursor).length).toBeGreaterThan(0);
    expect(port.isSkillsReachable('cursor', cursor)).toBe(true);
  });

  it('round-trips a backup: the digest taken equals the digest verified', async () => {
    // These are computed by two different walks — the live skill directory when
    // taking the backup, the copied directory when restoring it — keyed the same
    // way and each excluding a marker relative to its OWN walk root. If they could
    // ever disagree, restore would reject a perfectly good backup and recovery
    // would wedge itself: a denial of restore entirely of our own making.
    const { port } = harness();
    await port.installSkills('cursor', cursor);
    const backup = await port.backupSkills('cursor', cursor);

    const result = await port.restoreSkills('cursor', cursor, backup.backupPath, backup.digest);

    expect(result.ok, result.error ?? '').toBe(true);
  });

  it('round-trips nested content, where the two walks could most easily disagree', async () => {
    // Packaged skills render flat today, so the round-trip above only ever
    // exercises one file per directory. The two walks differ in their ROOT, and
    // both exclude `.mma-install.json` relative to their own root — a distinction
    // that is invisible until content is nested. Proving it now means a skill that
    // grows a subdirectory later cannot silently make restore reject its own
    // intact backup.
    const { computeSkillDigest, readInstalledRegularFiles } = await import('../../../packages/server/src/provisioning/owned-files.js');
    const { cpSync } = await import('node:fs');

    const live = mkdtempSync(join(tmpdir(), 'mma-nested-live-'));
    const skill = join(live, 'mma-audit');
    mkdirSync(join(skill, 'reference', 'deeper'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'top level');
    writeFileSync(join(skill, 'reference', 'a.md'), 'nested');
    writeFileSync(join(skill, 'reference', 'deeper', 'b.md'), 'deeper still');
    // A file NAMED like the marker but not at the walk root: it must be counted,
    // since the exclusion is root-relative, not name-based.
    writeFileSync(join(skill, 'reference', '.mma-install.json'), 'not the marker');
    writeFileSync(join(skill, '.mma-install.json'), JSON.stringify({ release: RELEASE, sha256: 'x' }));

    const taken = new Map<string, Buffer>();
    for (const [rel, bytes] of await readInstalledRegularFiles(skill)) taken.set(`mma-audit/${rel}`, bytes);

    const copy = mkdtempSync(join(tmpdir(), 'mma-nested-copy-'));
    cpSync(skill, join(copy, 'mma-audit'), { recursive: true });
    const verified = new Map<string, Buffer>();
    for (const [rel, bytes] of await readInstalledRegularFiles(join(copy, 'mma-audit'))) verified.set(`mma-audit/${rel}`, bytes);

    expect([...verified.keys()].sort()).toEqual([...taken.keys()].sort());
    expect([...taken.keys()]).toContain('mma-audit/reference/.mma-install.json');
    expect([...taken.keys()]).not.toContain('mma-audit/.mma-install.json');
    expect(computeSkillDigest(verified)).toBe(computeSkillDigest(taken));
  });

  it('restores from an intact backup', async () => {
    const { port } = harness();
    await port.installSkills('cursor', cursor);
    const backup = await port.backupSkills('cursor', cursor);
    const installedBefore = port.installedSkillNames('cursor', cursor);

    const result = await port.restoreSkills('cursor', cursor, backup.backupPath, backup.digest);

    expect(result.ok).toBe(true);
    expect(port.installedSkillNames('cursor', cursor)).toEqual(installedBefore);
  });

  it('refuses to install through a skill directory that is a symlink', async () => {
    const { symlinkSync, rmSync } = await import('node:fs');

    // The link points at a directory that is a PERFECTLY VALID installed skill:
    // right release, right digest, real marker. That matters — if the target were
    // arbitrary content, the missing/mismatched marker would reject it anyway and
    // the test would pass without the directory-classification guard doing
    // anything. Here the only thing standing between the write and someone else's
    // installation is recognising that the path itself is a link.
    const donor = harness();
    await donor.port.installSkills('cursor', cursor);
    const donorSkill = join(donor.home, '.agents', 'skills', 'mma-audit');
    const donorBytes = readFileSync(join(donorSkill, 'SKILL.md'), 'utf8');

    const { home, port } = harness();
    const root = join(home, '.agents', 'skills');
    mkdirSync(root, { recursive: true });
    symlinkSync(donorSkill, join(root, 'mma-audit'));
    // Prove the setup is otherwise indistinguishable from an owned install.
    expect(existsSync(join(root, 'mma-audit', '.mma-install.json'))).toBe(true);

    const result = await port.installSkills('cursor', cursor);

    expect(result.ok, 'ownership of a symlinked directory cannot be proven').toBe(false);
    expect(result.error).toMatch(/symlink/);
    expect(readFileSync(join(donorSkill, 'SKILL.md'), 'utf8'), "the donor's file is untouched")
      .toBe(donorBytes);

    // And removal is refused for the same reason, rather than deleting through it.
    const removed = await port.removeSkills('cursor', cursor, new Set());
    expect(removed.ok).toBe(false);
    expect(existsSync(donorSkill), 'the donor directory still exists').toBe(true);
    rmSync(donor.home, { recursive: true, force: true });
  });
});
