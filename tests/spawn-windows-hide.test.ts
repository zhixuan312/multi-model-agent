// Regression guard for the Windows console-window flashing bug.
//
// On Windows, child_process spawns a visible console window for each console
// binary (git.exe, codex.exe) unless `windowsHide: true` is passed. When the
// mma daemon has no attached console, every unhidden git spawn pops a
// window — the "flashing shell window" users reported on 4.7.10/4.7.11.
//
// This test scans packages/core/src for every child_process invocation of
// `git` and fails if the call does not carry `windowsHide: true`. It is a
// source-text tripwire, not a runtime check — a new git spawn added without
// the flag will fail CI on every platform.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_SRC = fileURLToPath(new URL('../packages/core/src', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Matches spawn / spawnSync / execFile / execFileSync / exec called with a
// literal 'git' (or "git") first argument.
const GIT_SPAWN = /\b(?:spawnSync|spawn|execFileSync|execFile|exec)\(\s*['"]git['"]/g;

describe('git child_process spawns set windowsHide (Windows flash guard)', () => {
  const files = walk(CORE_SRC);

  it('finds at least one git spawn (sanity: the scan actually matches)', () => {
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf8').match(GIT_SPAWN)?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it('every git spawn passes windowsHide: true', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(GIT_SPAWN)) {
        const start = m.index ?? 0;
        // Window = up to the NEXT git spawn or 400 chars, whichever comes
        // first — long enough to cover multi-line option objects, short
        // enough not to borrow a sibling call's flag. Search past the current
        // call's own `('git'` token so we don't truncate at it.
        const afterThisCall = start + m[0].length;
        const nextMatch = src.indexOf("('git'", afterThisCall);
        const end = Math.min(
          src.length,
          nextMatch === -1 ? start + 400 : nextMatch,
        );
        const slice = src.slice(start, end);
        if (!/windowsHide\s*:\s*true/.test(slice)) {
          const line = src.slice(0, start).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }

    expect(
      offenders,
      `git spawn(s) missing windowsHide: true (Windows console flash):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
