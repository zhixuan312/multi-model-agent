import { withRepoCommitLock, __repoLockMapSizeForTest } from '../../packages/core/src/lifecycle/repo-commit-lock.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('withRepoCommitLock', () => {
  it('serializes calls with the same key (no overlap)', async () => {
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    };
    await Promise.all([
      withRepoCommitLock('/repo/a', job),
      withRepoCommitLock('/repo/a', job),
      withRepoCommitLock('/repo/a', job),
    ]);
    expect(maxActive).toBe(1);
  });

  it('lets distinct keys overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    };
    await Promise.all([
      withRepoCommitLock('/repo/a', job),
      withRepoCommitLock('/repo/b', job),
    ]);
    expect(maxActive).toBe(2);
  });

  it('releases the lock after a throwing fn (no deadlock)', async () => {
    await expect(withRepoCommitLock('/repo/c', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    let ran = false;
    await withRepoCommitLock('/repo/c', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('returns the fn result', async () => {
    const v = await withRepoCommitLock('/repo/d', async () => 42);
    expect(v).toBe(42);
  });

  it('deletes idle keys from the map', async () => {
    await withRepoCommitLock('/repo/e', async () => { await tick(); });
    expect(__repoLockMapSizeForTest()).toBe(0);
  });
});
