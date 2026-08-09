import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * Release sweep: no retired lifecycle or classification term may survive in shipped assets.
 *
 * HERMETICITY. This scan is written in Node, deliberately. It previously shelled out to `rg`
 * (ripgrep) and asserted `result.status === 1`, meaning "ran, found nothing". On a machine without
 * ripgrep — every GitHub runner — `spawnSync` returns `status: null` instead, so the assertion
 * failed for a missing binary rather than for a real finding, and it blocked a release dry run.
 *
 * The deeper problem is worse than the red build: had the comparison been written the other way
 * round, a missing binary would have made the sweep PASS while scanning nothing at all. A gate that
 * silently stops gating is the failure this repository has already been bitten by elsewhere. Node's
 * own filesystem API has no such dependency.
 */

/** Directories that never contain shipped source, and would only slow the walk. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);
/** Text extensions worth scanning. A binary file cannot carry a retired term meaningfully. */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);

function* walkFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  if (statSync(root).isFile()) {
    yield root;
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(join(root, entry.name));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      yield join(root, entry.name);
    }
  }
}

/** Every `file:line` whose text matches `pattern`, across `roots`. */
function scan(roots: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // A fresh regex per test avoids `lastIndex` carrying over between lines on a /g pattern.
        if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
  }
  return hits;
}

describe('deliverable-agnostic engine release sweep', () => {
  it('has no retired lifecycle or classification terms in generic production assets', () => {
    // `judge` is scanned as the retired CONTRACT METHOD VALUE only — never as a bare word.
    // The journal skills legitimately use "judge" as an English verb (journal_record/implement.md,
    // journal_recall/implement.md, journal/adapters/journal-adapter.ts "retrieve-then-judge");
    // those are out of scope and must not fail this sweep.
    const retired = /kindConfirmation|methodProfile|done-with-unmet-signal|'judge'|"judge"|method:\s*judge|post-delivery action/;
    const hits = scan(['packages', 'DIRECTION.md', 'GUIDELINES.md', 'README.md', 'docs'], retired);
    expect(hits.join('\n'), 'retired lifecycle or classification terms are still present').toBe('');
  });

  it('does not inherit `rigor` through contract validation', () => {
    // `rigor` is scanned ONLY inside the contract-validation files, because the Errors bullet
    // retires rigor as CONTRACT INHERITANCE while the Behavior bullet keeps it as a legitimate
    // caller-facing interface default. A repo-wide scan would wrongly reject the permitted use.
    const hits = scan(
      [
        'packages/core/src/unified/deliverable-contract.ts',
        'packages/server/src/application/deliverable-contract-validator.ts',
      ],
      /\brigor\b/,
    );
    expect(hits.join('\n'), '`rigor` must not appear in contract validation').toBe('');
  });

  it('actually scans files, so a silent no-op cannot masquerade as a pass', () => {
    // The guard on the guard. If the walk ever stopped finding files — a renamed directory, a
    // changed extension list — both assertions above would pass while checking nothing.
    const scanned = [...walkFiles('packages/core/src/unified')];
    expect(scanned.length).toBeGreaterThan(10);
    expect(scan(['packages/core/src/unified/deliverable-contract.ts'], /canonicalContractDigest/).length)
      .toBeGreaterThan(0);
  });
});
