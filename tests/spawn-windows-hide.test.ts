// Regression guard for the Windows console-window flashing bug.
//
// On Windows, child_process spawns a visible console window for each console
// binary (git.exe, codex.exe) unless `windowsHide: true` is passed. When the
// mma daemon has no attached console, every unhidden git spawn pops a
// window — the "flashing shell window" users reported on 4.7.10/4.7.11.
//
// This test scans BOTH published source trees for every child_process invocation of a console
// binary and fails if the call does not carry `windowsHide: true`. It is a source-text tripwire,
// not a runtime check — a spawn added without the flag fails CI on every platform.
//
// It scanned only packages/core/src, and the regression had already recurred outside it:
// `packages/server/src/cli/initiative-import-bootstrap.ts` spawned `git remote get-url origin`
// with no flag, on a path that is NOT platform-gated, while this test stayed green. Two of the
// four unguarded spawns it now covers (`ps`, `lsof` in daemon-control) are genuinely win32-gated
// and could never flash; they carry the flag anyway, because a rule with no exceptions is easier
// to keep than one with a list of them — and the tripwire can then be absolute.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNED_ROOTS = [
  fileURLToPath(new URL('../packages/core/src', import.meta.url)),
  fileURLToPath(new URL('../packages/server/src', import.meta.url)),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Matches spawn / spawnSync / execFile / execFileSync / exec — and the promisified execFileAsync
// form used by repo-commit.ts — called with a literal console-binary first argument. `git` is the
// one that reaches Windows; `ps`/`lsof` are POSIX-only but are still ATTEMPTED there, and an
// attempted spawn is what flashes the window.
const CONSOLE_SPAWN =
  /\b(?:spawnSync|spawn|execFileSync|execFileAsync|execFile|exec)\(\s*['"](git|ps|lsof)['"]/g;

describe('console-binary spawns set windowsHide (Windows flash guard)', () => {
  const files = SCANNED_ROOTS.flatMap(walk);

  it('finds at least one git spawn (sanity: the scan actually matches)', () => {
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf8').match(CONSOLE_SPAWN)?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it('every git spawn passes windowsHide: true', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(CONSOLE_SPAWN)) {
        const start = m.index ?? 0;
        // Window = up to the NEXT git spawn or 400 chars, whichever comes
        // first — long enough to cover multi-line option objects, short
        // enough not to borrow a sibling call's flag. Search past the current
        // call's own `('git'` token so we don't truncate at it.
        const afterThisCall = start + m[0].length;
        // Bound the window at the next spawn of ANY scanned binary, in either quote style —
        // anchoring on one spelling let `spawn( "git"` borrow a sibling call's flag.
        const nextMatch = (() => {
          CONSOLE_SPAWN.lastIndex = afterThisCall;
          const next = CONSOLE_SPAWN.exec(src);
          const at = next?.index ?? -1;
          CONSOLE_SPAWN.lastIndex = 0;
          return at;
        })();
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
      `console-binary spawn(s) missing windowsHide: true (Windows console flash):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
