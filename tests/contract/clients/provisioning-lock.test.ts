/**
 * One provisioning mutation at a time, across processes.
 *
 * Every entry point that provisions is a separate OS process, and npm's
 * postinstall hook fires `mma sync-skills` on its own schedule — so the
 * realistic collision is a hook landing while somebody types a command, not two
 * humans racing. The ownership proofs elsewhere already make a torn shared root
 * SAFE; the lock is what makes the outcome useful rather than a refusal the user
 * has to re-run.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireProvisioningLock,
  withProvisioningLock,
  provisioningLockPath,
  ProvisioningLockTimeoutError,
} from '../../../packages/server/src/provisioning/provisioning-lock.js';
import { provisioningTestFixture } from '../fixtures/provisioning-fixture.js';
import { CLIENT_IDS } from '../../../packages/core/src/clients/client-id.js';

const stateDir = () => mkdtempSync(join(tmpdir(), 'mma-lock-'));

/**
 * A clock the test drives, for the cases that only wait in order to time out.
 *
 * `acquireProvisioningLock` declares `now`/`sleep` "injected for tests" and no test injected
 * either — a dormant seam, and the reason these cases spent real wall-clock polling. Advancing
 * virtual time inside `sleep` makes them deterministic and instant while exercising the seam.
 *
 * It starts from the REAL clock rather than zero: the staleness rule compares `now()` against the
 * lock file's `mtimeMs`, so a clock in 1970 would make every file look impossibly old and answer
 * "abandoned" for the wrong reason.
 */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = Date.now();
  return {
    now: () => t,
    // Advances virtual time AND yields a real macrotask. Resolving as a bare microtask makes the
    // acquire loop spin without ever returning to the event loop, so if the timeout check were
    // broken these cases would HANG instead of failing — vitest's own timer could never fire.
    // Verified: with the timeout removed, the microtask version hung indefinitely.
    sleep: async (ms: number) => { t += ms; await new Promise((resolve) => setImmediate(resolve)); },
  };
}

describe('contract: the provisioning lock serialises mutations across processes', () => {
  it('a second acquirer waits, then gets it once the first releases', async () => {
    const dir = stateDir();
    const first = await acquireProvisioningLock(dir);
    expect(existsSync(provisioningLockPath(dir))).toBe(true);

    let got = false;
    const second = acquireProvisioningLock(dir, { timeoutMs: 5_000 }).then((l) => { got = true; return l; });
    await new Promise((r) => setTimeout(r, 150));
    expect(got, 'must not be handed the lock while it is held').toBe(false);

    first.release();
    (await second).release();
    expect(got).toBe(true);
    expect(existsSync(provisioningLockPath(dir)), 'released locks leave no file').toBe(false);
  });

  it('refuses rather than proceeding unlocked when a live holder will not yield', async () => {
    // Proceeding anyway is the single outcome this module exists to prevent, so
    // the timeout is a hard error naming the holder — not a silent fallback.
    const dir = stateDir();
    const held = await acquireProvisioningLock(dir);
    await expect(acquireProvisioningLock(dir, { timeoutMs: 120, ...virtualClock() }))
      .rejects.toBeInstanceOf(ProvisioningLockTimeoutError);
    held.release();
  });

  it('takes over a lock whose holder is gone, so a crash cannot wedge provisioning forever', async () => {
    const dir = stateDir();
    // pid 2^22 is above every platform's pid_max — provably not running.
    writeFileSync(provisioningLockPath(dir), JSON.stringify({ pid: 4_194_304, host: hostname(), acquiredAt: Date.now() }));
    const lock = await acquireProvisioningLock(dir, { timeoutMs: 2_000 });
    expect(JSON.parse(readFileSync(provisioningLockPath(dir), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('never steals from a pid recorded by a DIFFERENT host', async () => {
    // A pid means nothing across machines: on a shared filesystem, "is 1234
    // running" answered locally would happily steal a live remote holder's lock.
    const dir = stateDir();
    writeFileSync(provisioningLockPath(dir), JSON.stringify({ pid: 4_194_304, host: 'some-other-machine', acquiredAt: Date.now() }));
    await expect(acquireProvisioningLock(dir, { timeoutMs: 120, ...virtualClock() }))
      .rejects.toBeInstanceOf(ProvisioningLockTimeoutError);
  });

  it('takes over an unreadable lock only once it is older than the stale window', async () => {
    const dir = stateDir();
    writeFileSync(provisioningLockPath(dir), 'not json {{{');
    // Fresh: could be a file being written right this instant.
    await expect(acquireProvisioningLock(dir, { timeoutMs: 120, staleMs: 60_000, ...virtualClock() }))
      .rejects.toBeInstanceOf(ProvisioningLockTimeoutError);
    // Aged out: there is no holder left to ask.
    const lock = await acquireProvisioningLock(dir, { timeoutMs: 2_000, staleMs: 0 });
    lock.release();
  });

  it('releases on a throw, so one failure cannot wedge every later run', async () => {
    const dir = stateDir();
    await expect(withProvisioningLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(provisioningLockPath(dir)), 'the lock must not survive the throw').toBe(false);
    (await acquireProvisioningLock(dir, { timeoutMs: 500 })).release();
  });

  it('does not delete a lock that was stolen from it', async () => {
    // Releasing blindly would hand a third process a turn the current holder is
    // still using.
    const dir = stateDir();
    const mine = await acquireProvisioningLock(dir);
    writeFileSync(provisioningLockPath(dir), JSON.stringify({ pid: process.pid + 1, host: hostname(), acquiredAt: Date.now() }));
    mine.release();
    expect(existsSync(provisioningLockPath(dir)), "the successor's lock must survive").toBe(true);
  });
});

/**
 * Reference counting is about the ROOT, not about how many clients happen to be
 * enabled. `~/.agents/skills` is one physical copy read by cursor, VS Code and
 * opencode; every other client has a root of its own.
 */
describe('contract: shared-root reference counting counts root sharers only', () => {
  it('removes a client\'s skills even while an unrelated client is enabled', async () => {
    // claude-code (~/.claude/skills) and codex (~/.codex/skills) share nothing.
    // Counting every enabled client instead left ~/.claude/skills on disk
    // forever whenever codex happened to be on — a disable that reported
    // success and removed nothing.
    const fixture = provisioningTestFixture({
      clients: { 'claude-code': 'on', codex: 'on' },
    });
    await fixture.provisionAll();
    expect(fixture.installedSkillNames('claude-code').length).toBeGreaterThan(0);

    fixture.setClientState('claude-code', 'off');
    await fixture.provision(['claude-code']);

    expect(fixture.installedSkillNames('claude-code'), 'codex does not share this root').toEqual([]);
    expect(fixture.installedSkillNames('codex').length, 'and codex keeps its own').toBeGreaterThan(0);
  });

  it('keeps a genuinely shared root while a sharer is still enabled', async () => {
    const fixture = provisioningTestFixture({
      clients: { cursor: 'on', vscode: 'on' },
    });
    await fixture.provisionAll();

    fixture.setClientState('cursor', 'off');
    await fixture.provision(['cursor']);

    expect(fixture.installedSkillNames('vscode'), 'vscode still reads ~/.agents/skills')
      .toEqual(fixture.packagedSkillNames());
  });

  it('removes the shared root once its last consumer leaves', async () => {
    const fixture = provisioningTestFixture({
      clients: { cursor: 'on', vscode: 'on' },
    });
    await fixture.provisionAll();

    fixture.setClientState('cursor', 'off');
    await fixture.provision(['cursor']);
    fixture.setClientState('vscode', 'off');
    await fixture.provision(['vscode']);

    expect(fixture.installedSkillNames('vscode')).toEqual([]);
  });
});

describe('contract: the service actually takes the lock', () => {
  it('a mutation refuses while another process holds it; a read does not', async () => {
    // Testing the lock module alone proves the primitive works, not that
    // provisioning uses it — the wiring is the part that can silently regress.
    const fixture = provisioningTestFixture({
      clients: { cursor: 'on' },
      lockOptions: { timeoutMs: 150 },
    });
    const held = await acquireProvisioningLock(fixture.stateDir);
    try {
      await expect(fixture.provision(['cursor']), 'provision must serialise')
        .rejects.toBeInstanceOf(ProvisioningLockTimeoutError);
      await expect(fixture.recoverOnStartup(), 'recovery mutates too')
        .rejects.toBeInstanceOf(ProvisioningLockTimeoutError);
      // Inventory is read-only: blocking it would make `mma clients` hang
      // behind an npm postinstall for no benefit.
      await expect(fixture.inventory()).resolves.toHaveLength(CLIENT_IDS.length);
    } finally {
      held.release();
    }
    // And it proceeds once the holder is gone.
    const after = await fixture.provision(['cursor']);
    expect(after.byClient.cursor?.status).toBe('provisioned');
  });
});
