import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';

const root = resolve(import.meta.dirname, '../..');
const retiredAssets = ['packages/core/src/skills/debug/implement-software.md', 'packages/core/src/skills/execute_plan/implement-software.md', 'packages/core/src/skills/plan/implement-software.md', 'packages/core/src/skills/review/implement-software.md'];
/**
 * Scanned: the whole repository, not a curated list.
 *
 * `scopedFiles` used to enumerate 26 paths, and its own comment recorded the list having missed
 * files TWICE — the smoke harness and the public docs each kept naming the retired field past
 * removal because nobody remembered to add them. A sweep whose coverage is a list is a sweep that
 * silently narrows, which is the failure mode it exists to prevent.
 *
 * Walking the tree costs a few hundred milliseconds and cannot miss. Exactly two files may match,
 * and both are named with a reason:
 *   - `CHANGELOG.md` — history has to be able to say what was removed.
 *   - this file — it holds the pattern.
 */
const SCAN_EXTENSIONS = ['.ts', '.md', '.mjs', '.js', '.json'];
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.mma', '.superpowers', 'coverage']);
const ALLOWED_TO_MATCH = new Set([
  'CHANGELOG.md',
  'tests/contract/practice-removal-sweep.test.ts',
]);

const RESIDUAL = /\bpracticeOf\b|\bskillSelectorOf\b|routing\.practice|"practice"\s*:|`practice`|practice:\s*'software'|implement-software\.md/;

function scanTree(dir: string, rel = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return SCAN_SKIP_DIRS.has(entry.name) ? [] : scanTree(resolve(dir, entry.name), relPath);
    }
    if (!SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) return [];
    return RESIDUAL.test(readFileSync(resolve(dir, entry.name), 'utf8')) ? [relPath] : [];
  });
}


describe('practice removal sweep', () => {
  it('removes the retired public mechanism without changing audit subtype', () => {
    expect(taskInputSchema.safeParse({ type: 'review', target: { paths: ['/tmp/a.ts'] }, practice: 'software' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, subtype: 'plan' }).success).toBe(true);
    for (const asset of retiredAssets) expect(existsSync(resolve(root, asset))).toBe(false);
    const offenders = scanTree(root).filter((file) => !ALLOWED_TO_MATCH.has(file));
    expect(offenders, `retired technique-selector mechanism still named in: ${offenders.join(', ')}`).toEqual([]);
    expect(existsSync(resolve(root, 'packages/core/src/methods/software-change/guidance.md'))).toBe(true);
    expect(readFileSync(resolve(root, 'packages/core/src/methods/software-change/guidance.md'), 'utf8')).toMatch(/Caller tracing[\s\S]*Error-path review[\s\S]*Security-sink review[\s\S]*Schema conformance[\s\S]*Test adequacy/);
  });
});