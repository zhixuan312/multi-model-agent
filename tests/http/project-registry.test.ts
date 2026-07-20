import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../packages/server/src/http/project-registry.js';

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

  it('reserveProject increments pendingReservations', () => {
    const r = reg.reserveProject(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projectContext.pendingReservations).toBe(1);
    reg.reserveProject(dir);
    expect(r.projectContext.pendingReservations).toBe(2);
  });

  it('cancelReservation decrements pendingReservations', () => {
    const r = reg.reserveProject(dir);
    if (!r.ok) return;
    reg.reserveProject(dir);
    expect(r.projectContext.pendingReservations).toBe(2);
    reg.cancelReservation(r.projectContext.cwd);
    expect(r.projectContext.pendingReservations).toBe(1);
  });

  it('reserveProject returns project_cap error when full and target is new', () => {
    reg.reserveProject(tmpDir());
    reg.reserveProject(tmpDir());
    reg.reserveProject(tmpDir());
    const r = reg.reserveProject(tmpDir());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('project_cap');
  });

  it('reserveProject succeeds when full but target is already tracked', () => {
    const dirs = [tmpDir(), tmpDir(), tmpDir()];
    dirs.forEach(d => reg.reserveProject(d));
    const r = reg.reserveProject(dirs[0]); // already exists
    expect(r.ok).toBe(true);
  });
});
