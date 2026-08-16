// Regression guard for the Windows console-window flashing bug.
//
// On Windows, child_process spawns a visible console window for each console binary unless
// `windowsHide: true` is passed. When the mma daemon has no attached console, every unhidden spawn
// pops a window — the "flashing shell window" users reported on 4.7.10/4.7.11.
//
// This is a source-text tripwire, not a runtime check: a spawn added without the flag fails CI on
// every platform.
//
// It has now been too narrow TWICE, each time in the same way — a hand-written list.
//
//   1. It scanned only `packages/core/src`, while the regression sat in
//      `packages/server/src/cli/initiative-import-bootstrap.ts`. Fixed by scanning both trees.
//   2. It matched only a LITERAL first argument from the list `git|ps|lsof`, so every spawn whose
//      binary is a variable was invisible — and seven were unguarded, including the two that matter
//      most: `two-phase-pipeline.ts`'s acceptance-command runner (one window per acceptance check,
//      on the main execute_plan path) and `sqlite-store.ts`'s verification-command runner. Its own
//      header named `codex.exe` as a flashing binary while the pattern never looked for it.
//
// So the roster is no longer written down. Every call to a name imported from `node:child_process`
// — or from `cross-spawn`, which codex-cli-session uses — must carry the flag, with no exceptions
// for POSIX-only binaries: `ps`/`lsof` are never reached on Windows but carry it anyway, because a
// rule with no exceptions is easier to keep than one with a list of them, and the tripwire can then
// be absolute.

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
/**
 * The child_process (or cross-spawn) names a file imports, so the scan follows what the FILE
 * actually calls rather than a list of binaries someone remembered.
 */
function spawnNamesFor(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(?:node:child_process|cross-spawn)'/g)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      // `ChildProcess` and friends are TYPES — they are never called.
      if (name && /^(spawn|spawnSync|exec|execSync|execFile|execFileSync|execFileAsync)$/.test(name)) {
        names.add(name);
      }
    }
  }
  // cross-spawn's default import is the spawn function itself.
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+'cross-spawn'/g)) names.add(m[1]!);
  return [...names];
}

/**
 * The index just past the call's closing paren, by matching parens from the opening one.
 *
 * A fixed character window was wrong in both directions: too short and it misses the flag (the
 * codex spawn carries a ~20-line comment inside its options object before reaching `windowsHide`,
 * so 700 chars failed a call that IS guarded), too long and one call borrows the next one's flag.
 * Matching the parens is exact, and it is what "this call's options" actually means. Quotes are
 * tracked so a paren inside a string argument does not close the call early.
 */
function callEnd(src: string, openParen: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i += 1) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Every (file, line, callText) triple where such a name is invoked. */
function spawnCalls(): { file: string; line: number; slice: string }[] {
  const out: { file: string; line: number; slice: string }[] = [];
  for (const file of SCANNED_ROOTS.flatMap(walk)) {
    const src = readFileSync(file, 'utf8');
    const names = spawnNamesFor(src);
    if (names.length === 0) continue;
    const pattern = new RegExp(`\\b(?:${names.join('|')})\\(`, 'g');
    for (const m of src.matchAll(pattern)) {
      const start = m.index ?? 0;
      out.push({
        file,
        line: src.slice(0, start).split('\n').length,
        slice: src.slice(start, callEnd(src, start + m[0].length - 1)),
      });
    }
  }
  return out;
}

describe('console-binary spawns set windowsHide (Windows flash guard)', () => {
  const calls = spawnCalls();

  it('finds the spawn sites (sanity: the scan actually matches)', () => {
    // Floor. The previous version asserted `> 0`, which a pattern matching one file would satisfy
    // while missing six. There are 12 across both trees today.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    // And it must reach BOTH trees — the first miss was an entire package going unscanned.
    expect(calls.some((c) => c.file.includes('packages/core/src'))).toBe(true);
    expect(calls.some((c) => c.file.includes('packages/server/src'))).toBe(true);
  });

  it('every child_process spawn passes windowsHide: true', () => {
    const offenders = calls
      .filter((c) => !/windowsHide\s*:\s*true/.test(c.slice))
      .map((c) => `${c.file}:${c.line}`);

    expect(
      offenders,
      `spawn(s) missing windowsHide: true (Windows console flash):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
