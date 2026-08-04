import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProvisioningService } from '../../../packages/server/src/provisioning/service.js';

/**
 * The seven contract assertions the plan requires on top of the materialized
 * acceptance test in `atomic-provisioning-and-recovery.test.ts`.
 *
 * Why they exist as their own file: a first implementation of Task I-7 PASSED that
 * acceptance test while leaving the contract unmet — markers never carried a real
 * `priorSkillBackup`, no `skills-written` phase was ever written, recovery cleared
 * markers even when restoration failed, reachability checked neither writability nor
 * the recorded precondition, and daemon start never invoked recovery at all. A test
 * that green-lights that is measuring the wrong thing. Each case below pins one of
 * those specific ways the guarantee can be hollow while still looking implemented.
 */
describe('contract: durable provisioning markers and recovery — the seven guarantees', () => {
  const onFixture = () => createProvisioningService.testFixture({
    clients: { cursor: 'on', vscode: 'on', codex: 'on', 'claude-desktop': 'on' },
  });

  // 1. Phases are a real ordered progression, not a single 'started' stamp.
  it('writes all three phases in order for a completed provision, then clears the marker', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);

    expect(fixture.phaseHistory('cursor')).toEqual(['started', 'registered', 'skills-written']);
    expect(fixture.marker('cursor')).toBeNull();
  });

  // 2. A digest cannot restore anything: it holds neither the prior bytes nor the
  //    prior renderer. The backup must be real, on disk, and readable.
  it('records a priorSkillBackup pointing at real restorable bytes, not a placeholder', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);           // establishes content to back up
    const before = fixture.installedSkillNames('cursor');
    expect(before.length).toBeGreaterThan(0);

    fixture.interruptAfter('skills-written', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    const marker = fixture.marker('cursor');
    expect(marker).not.toBeNull();
    expect(marker!.priorSkillBackup, 'a null backup cannot restore anything').not.toBeNull();
    expect(existsSync(marker!.priorSkillBackup!), 'backup path must exist on disk').toBe(true);
    expect(readdirSync(marker!.priorSkillBackup!).length, 'backup must hold real bytes').toBeGreaterThan(0);
    expect(marker!.priorSkillDigest).not.toBeNull();
  });

  // 3. Clearing a marker is a claim that the client is consistent again. A failed
  //    restore must NOT make that claim.
  it('leaves the marker in place and reports failed when recovery cannot restore', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    fixture.makeUnrestorable('cursor');
    const reports = await fixture.recoverOnStartup();

    expect(reports.find((r) => r.clientId === 'cursor')?.resolved).toBe(false);
    expect(fixture.marker('cursor'), 'an unresolved marker must survive').not.toBeNull();
    const record = (await fixture.inventory()).find((r) => r.clientId === 'cursor');
    expect(record?.mcpRegistrationStatus).toBe('failed');
  });

  // 4. A corrupt marker is the one case where state is least knowable — so it must
  //    be surfaced, never skipped as if the client were clean.
  it('reports and recovers a corrupt marker rather than silently ignoring it', async () => {
    const fixture = onFixture();
    fixture.writeCorruptMarker('cursor');

    const record = (await fixture.inventory()).find((r) => r.clientId === 'cursor');
    expect(record?.mcpRegistrationStatus, 'a corrupt marker is unresolved, so: failed').toBe('failed');

    const reports = await fixture.recoverOnStartup();
    expect(reports.some((r) => r.clientId === 'cursor'), 'corrupt marker must be reported').toBe(true);
  });

  // 5a. Reachability must consider whether the target can actually be written.
  it('treats a phase as unreachable when its target is not writable', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    fixture.makeSkillsUnwritable('cursor');
    // phaseHistory accumulates across the fixture's whole lifetime, so the earlier
    // successful provision already contains 'skills-written'. What matters is
    // whether RECOVERY advanced it — measure the delta, not the total.
    const before = fixture.phaseHistory('cursor').length;
    await fixture.recoverOnStartup();
    const appended = fixture.phaseHistory('cursor').slice(before);

    // Unreachable => restore, never "complete anyway".
    expect(appended, 'recovery must not advance a phase whose target is unwritable')
      .not.toContain('skills-written');
  });

  // 5b. Writability alone is not enough: the observed state must still match what
  //     the marker recorded, or completing would build on a changed foundation.
  it('treats a phase as unreachable when the observed state no longer matches the recorded precondition', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    fixture.tamperRegistration('cursor');
    const reports = await fixture.recoverOnStartup();

    expect(reports.some((r) => r.clientId === 'cursor')).toBe(true);
  });

  // 6. Recovery that only runs on the next provisioning call leaves a crashed
  //    install stranded for as long as nobody provisions again.
  it('resolves a pending marker at daemon start, before inventory can report healthy', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    // Pending marker on disk: inventory must not call this client healthy.
    expect(fixture.marker('cursor')).not.toBeNull();
    const beforeBoot = (await fixture.inventory()).find((r) => r.clientId === 'cursor');
    expect(beforeBoot?.mcpRegistrationStatus).toBe('failed');

    await fixture.recoverOnStartup();

    expect(fixture.marker('cursor')).toBeNull();
    const afterBoot = (await fixture.inventory()).find((r) => r.clientId === 'cursor');
    expect(afterBoot?.mcpRegistrationStatus).not.toBe('failed');
  });

  // 7. "Leave neither installed" is not the same as "put back what was there".
  //    A re-provision that fails at the skills phase must not destroy a working
  //    registration the user already had.
  it('restores the prior registration when the skill write fails, rather than removing it', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    const original = fixture.registrationEntry('cursor');
    expect(original, 'a registration must exist to be restored').not.toBeNull();

    fixture.failSkillsFor.add('cursor');
    await fixture.provision(['cursor']);

    expect(fixture.registrationEntry('cursor'), 'prior registration must be restored, not removed')
      .toEqual(original);
  });

  // Shared roots are reference-counted: one client leaving must not strip a root
  // its siblings still consume. cursor, vscode and opencode all read ~/.agents/skills.
  it('keeps a shared skill root populated while another enabled client still consumes it', async () => {
    const fixture = onFixture();
    await fixture.provisionAll();
    expect(fixture.installedSkillNames('vscode')).toEqual(fixture.packagedSkillNames());

    fixture.setClientState('cursor', 'off');
    await fixture.provision(['cursor']);

    expect(fixture.installedSkillNames('vscode'), 'vscode still needs ~/.agents/skills')
      .toEqual(fixture.packagedSkillNames());
  });
});

/**
 * A surviving marker says the previous run did not finish CLEANLY. It does not say
 * the previous run failed. Conflating the two is its own data-loss bug, and it is
 * the one the cases below pin down — along with the two ways a restore can destroy
 * more than it repairs.
 */
describe('contract: recovery distinguishes an unfinished operation from an unrecorded one', () => {
  const onFixture = () => createProvisioningService.testFixture({
    clients: { cursor: 'on', vscode: 'on', codex: 'on', 'claude-desktop': 'on' },
  });

  /**
   * Die in the window between the terminal phase being written and the marker
   * being cleared -- on the client's FIRST provision, so the pre-operation state
   * (no registration, no skills) is observably different from the post-operation
   * state. Stranding a RE-provision instead would leave the two states identical,
   * and a wrongful revert would be invisible to any assertion.
   */
  async function strandFirstInstallTerminalMarker(fixture: ReturnType<typeof onFixture>): Promise<void> {
    fixture.interruptAfter('skills-written', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });
  }

  it('finishes a completed operation whose marker was never cleared, instead of reverting it', async () => {
    const fixture = onFixture();
    await strandFirstInstallTerminalMarker(fixture);

    const marker = fixture.marker('cursor');
    expect(marker?.phase, "the stranded marker records the operation's terminal phase").toBe('skills-written');
    expect(marker?.priorRegistration?.existed, 'this install started from nothing').toBe(false);
    const installedBefore = fixture.installedSkillNames('cursor');
    const registrationBefore = fixture.registrationEntry('cursor');
    expect(installedBefore).toEqual(fixture.packagedSkillNames());
    expect(registrationBefore).not.toBeNull();

    const reports = await fixture.recoverOnStartup();

    expect(reports.find((r) => r.clientId === 'cursor')?.resolved).toBe(true);
    expect(fixture.marker('cursor'), 'the bookkeeping step is what recovery finishes').toBeNull();
    // Restoring the recorded starting point here would mean removing both — a
    // correctly provisioned client silently de-provisioned by its own recovery.
    expect(fixture.installedSkillNames('cursor'), 'a client that IS provisioned must stay provisioned')
      .toEqual(installedBefore);
    expect(fixture.registrationEntry('cursor')).toEqual(registrationBefore);
  });

  it('discards the skill backup once the marker it belonged to is gone', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);   // creates content
    await fixture.provision(['cursor']);   // backs that content up, then succeeds

    expect(fixture.skillBackupDirs(), 'a completed operation leaves no backup behind').toEqual([]);

    // A re-provision stranded at its terminal phase: this one DOES have a backup,
    // because there was existing content to capture.
    fixture.interruptAfter('skills-written', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });
    expect(fixture.skillBackupDirs().length, 'a pending marker still needs its backup').toBeGreaterThan(0);

    await fixture.recoverOnStartup();
    expect(fixture.skillBackupDirs(), 'resolved marker, so the backup is reclaimed').toEqual([]);
  });

  it('refuses to restore over a registration a third party changed after the crash', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    // The user opens their MCP config and adds an unrelated server. A whole-file
    // restore of the pre-operation snapshot would erase that edit without a word.
    const theirEdit = { mma: { url: 'http://127.0.0.1/mcp' }, 'their-own-server': { url: 'http://127.0.0.1:9999/mcp' } };
    fixture.editRegistrationOutsideMma('cursor', theirEdit);

    const reports = await fixture.recoverOnStartup();

    expect(reports.find((r) => r.clientId === 'cursor')?.resolved).toBe(false);
    expect(fixture.registrationEntry('cursor'), 'their edit survives').toEqual(theirEdit);
    expect(fixture.marker('cursor'), 'unresolved means the marker stays for an operator').not.toBeNull();
  });

  it('refuses at the started phase too, where no post-mutation fingerprint was ever recorded', async () => {
    // The window between the registration write landing and the phase transition
    // being persisted. A marker stuck at `started` has no post-mutation
    // fingerprint, so a drift check gated on one would simply not run — and the
    // whole-file restore would proceed over whatever is there now. Recording the
    // PRE-mutation fingerprint instead makes the check apply uniformly.
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('started', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });
    expect(fixture.marker('cursor')?.phase).toBe('started');

    const theirEdit = { mma: { url: 'http://127.0.0.1/mcp' }, 'their-own-server': { url: 'http://127.0.0.1:9999/mcp' } };
    fixture.editRegistrationOutsideMma('cursor', theirEdit);

    const reports = await fixture.recoverOnStartup();

    expect(reports.find((r) => r.clientId === 'cursor')?.resolved).toBe(false);
    expect(fixture.registrationEntry('cursor'), 'their edit survives').toEqual(theirEdit);
  });

  it('keeps the live skills when the backup it would restore from has vanished', async () => {
    const fixture = onFixture();
    await fixture.provision(['cursor']);
    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });

    // A reboot, or a tmp sweep, between the crash and this recovery run.
    fixture.deleteSkillBackup('cursor');
    const reports = await fixture.recoverOnStartup();

    expect(reports.find((r) => r.clientId === 'cursor')?.resolved).toBe(false);
    expect(fixture.installedSkillNames('cursor'), 'no backup is a reason to keep what is there, not to delete it')
      .toEqual(fixture.packagedSkillNames());
  });
});
