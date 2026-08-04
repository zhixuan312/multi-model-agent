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
