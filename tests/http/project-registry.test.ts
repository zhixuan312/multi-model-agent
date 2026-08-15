import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../packages/server/src/application/project-registry.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
}

describe('ProjectRegistry', () => {
  let reg: ProjectRegistry;
  let dir: string;
  beforeEach(() => {
    reg = new ProjectRegistry({ cap: 3 });
    dir = tmpDir();
  });

  it('reserveProject creates a new ProjectContext on miss, returns existing on hit', () => {
    const r1 = reg.reserveProject(dir);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = reg.reserveProject(dir);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r1.projectContext).toBe(r2.projectContext);
  });

  // The two tests that stood here asserted a `pendingReservations` counter going up and back down.
  // Nothing else read it — not eviction (which consults `isBusy`), not /status (which reports live
  // task counts) — so they proved only that the bookkeeping bookkept itself. What reserving a
  // project must actually do is asserted by the identity and cap tests around them.
  it('returns the SAME context for a repeated cwd rather than a second one', () => {
    const first = reg.reserveProject(dir);
    const second = reg.reserveProject(dir);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.projectContext).toBe(first.projectContext);
    expect(second.created).toBe(false);
    expect(reg.size).toBe(1);
  });

  it('reserveProject returns project_cap when full and every project is busy (unevictable)', () => {
    // isBusy=always true → nothing is evictable → cap is a hard wall.
    const busyReg = new ProjectRegistry({ cap: 3, isBusy: () => true });
    busyReg.reserveProject(tmpDir());
    busyReg.reserveProject(tmpDir());
    busyReg.reserveProject(tmpDir());
    const r = busyReg.reserveProject(tmpDir());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('project_cap');
  });

  it('reserveProject succeeds when full but target is already tracked', () => {
    const dirs = [tmpDir(), tmpDir(), tmpDir()];
    dirs.forEach(d => reg.reserveProject(d));
    const r = reg.reserveProject(dirs[0]); // already exists
    expect(r.ok).toBe(true);
  });

  // ── Idle-project eviction at cap (finding #11: no permanent lockout) ──

  it('evicts the LRU idle project (not busy, no context blocks) to admit a new one at cap', () => {
    const busy = new Set<string>();
    const evReg = new ProjectRegistry({ cap: 2, isBusy: (cwd) => busy.has(cwd) });
    const a = tmpDir(), b = tmpDir(), c = tmpDir();
    const ra = evReg.reserveProject(a);
    const rb = evReg.reserveProject(b);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    busy.add(rb.projectContext.cwd);          // b is busy → unevictable; a is idle
    expect(evReg.size).toBe(2);               // at cap

    const rc = evReg.reserveProject(c);       // must evict idle 'a', admit 'c'
    expect(rc.ok).toBe(true);
    expect(evReg.get(ra.projectContext.cwd)).toBeUndefined(); // a evicted
    expect(evReg.get(rb.projectContext.cwd)).toBeDefined();   // busy b kept
    expect(evReg.size).toBe(2);
  });

  it('does NOT evict a project that still holds context blocks; rejects instead', () => {
    const holdReg = new ProjectRegistry({ cap: 1 });
    const a = tmpDir();
    const ra = holdReg.reserveProject(a);
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    ra.projectContext.contextBlocks.register('keep-me'); // project retains state
    const rb = holdReg.reserveProject(tmpDir());          // cap 1, a unevictable
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.error).toBe('project_cap');
    expect(holdReg.get(ra.projectContext.cwd)).toBeDefined(); // a preserved
  });
});
