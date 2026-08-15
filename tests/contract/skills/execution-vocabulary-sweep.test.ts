import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['packages/server/src/skills', 'plugin/skills', 'plugin/commands', 'tests/contract/goldens', 'tests/contract/mcp'];
const stale = [/POST \/task\b/, /GET \/task\b/, /DELETE \/task\b/, /\bmma_task_(get|wait|cancel|list)\b/, /\bpoll\.taskId\b/, /\btaskId\b/, /"task"\s*:\s*\{/];
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}

describe('packaged execution vocabulary', () => {
  it('has no stale execution route or tool reference in the required trees', () => {
    const matches = roots.flatMap((root) => files(root).flatMap((file) => stale.some((pattern) => pattern.test(readFileSync(file, 'utf8'))) ? [file] : []));
    expect(matches).toEqual([]);
  });

  /**
   * The same sweep over the trees that ISSUE requests, which `roots` above does not cover.
   *
   * Five separate checks kept passing after SPEC-003 renamed `/task` to `/execution`, all for the
   * same reason: a request to a route that no longer exists returns 404, and a loose assertion
   * (`status !== 503`, `payload?.task?.status`) swallows a 404 without complaint. A guard that
   * merely LISTS the old name just quietly stops matching. None of it is visible in a green suite.
   *
   * Only the request-shaped spellings are matched — a bare word `task` is a normal identifier in
   * both trees, and flagging it would make this unusable.
   */
  it('issues no request to a retired execution route from tests or scripts', () => {
    // Comments are stripped first. Explaining the rename REQUIRES naming the old route, so a
    // comment-blind sweep flags the very notes that record why the rename mattered — and the
    // obvious way to quiet it is to delete the explanation.
    // The `(?<!:)` matters: a naive `//` stripper truncates every line containing a URL at
    // `http://`, which deletes exactly the request paths this sweep looks for. Found by
    // reintroducing the defect and watching the sweep stay green.
    const stripComments = (text: string): string => text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.replace(/(?<!:)\/\/.*$/, '')).join('\n');
    const requestShaped = [/\/task\?/, /\/task\/\$\{/, /['"`]\/task['"`]/, /baseUrl\}\/task\b/];
    // Two files name the retired route ON PURPOSE, and must keep doing so.
    const intentional = new Set([
      // Asserts the retired route is GONE (404) — the only place that should still reach for it.
      'tests/contract/http/execution-route-contract.test.ts',
      // Forbids skills from teaching an agent EITHER route; the old spelling stays in the pattern
      // so a stale copy-paste is still caught.
      'scripts/full-smoke/preflight.mjs',
    ]);
    const offenders = ['tests', 'scripts'].flatMap((root) => files(root)).filter((file) => {
      if (!/\.(ts|mjs)$/.test(file) || intentional.has(file)) return false;
      const code = stripComments(readFileSync(file, 'utf8'));
      return requestShaped.some((pattern) => pattern.test(code));
    });
    expect(offenders).toEqual([]);
  });
  /**
   * The documented terminal-status vocabulary must be one the engine can actually emit.
   *
   * Every SKILL.md advertised `"completed | done_with_concerns | failed | cancelled"`. The engine
   * has never emitted `completed` — the pipeline returns `done`, and `completed` belongs to the
   * Initiative Record's TASK status enum, a different vocabulary in a different subsystem. A caller
   * following the documentation and branching on `status === 'completed'` matched nothing, on every
   * task, forever. Nothing caught it: the docs are prose, the enum is a TypeScript union, and no
   * test compared them. The stale-pattern sweep above catches retired NAMES; this catches a
   * documented value that never existed.
   */
  it('documents only terminal statuses the engine can emit', () => {
    // FIVE, not four. `interrupted` was missing here and from every packaged doc: boot
    // reconciliation builds a terminal envelope with `status: 'interrupted'` for an execution a
    // daemon restart orphaned, and `GET /execution/:id` serves it from the store. A consumer
    // switching on four values meets an unhandled state the first time a daemon restarts mid-run.
    const AUTHORITATIVE = ['done', 'done_with_concerns', 'failed', 'cancelled', 'interrupted'];

    // Half one: the pipeline still produces the three it owns. If someone renames them, this fails
    // here rather than leaving the docs quietly wrong again.
    const pipeline = readFileSync('packages/core/src/unified/two-phase-pipeline.ts', 'utf8');
    expect(pipeline).toContain("status: 'done' | 'done_with_concerns' | 'failed'");
    // …and the runtime supplies the fourth, for a cancel that beat completion.
    const runtime = readFileSync('packages/server/src/application/execution-runtime.ts', 'utf8');
    expect(runtime).toContain("'cancelled' as const");
    // …and reconciliation supplies the fifth, through the shared error-envelope builder.
    const resultShape = readFileSync('packages/server/src/application/result-shape.ts', 'utf8');
    expect(resultShape).toContain("'failed' | 'cancelled' | 'interrupted'");
    const reconcile = readFileSync('packages/server/src/application/reconcile.ts', 'utf8');
    expect(reconcile).toContain("'interrupted'");

    // Half two: every packaged doc that states the union states exactly that set.
    //
    // Only UNIONS are candidates — a `"status"` written as a single literal is a different field:
    // `"ok"` is /health, `"open"` is an Initiative Record task. Those vocabularies coexist
    // legitimately, and conflating them is what produced the bug in the first place.
    const documented = roots.flatMap((root) => files(root)).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/"status":\s*"([a-z_]+(?:\s*\|\s*[a-z_]+)+)"/g)]
        .map((m) => ({ file, values: m[1]!.split('|').map((v) => v.trim()) }));
    });
    expect(documented.length, 'the response-shape doc should be found in the packaged trees').toBeGreaterThan(0);
    for (const { file, values } of documented) {
      expect(values, file).toEqual(AUTHORITATIVE);
    }
  });

  it('keeps the packaged flow skill and its generated plugin command aligned on Record Integration', () => {
    for (const file of ['packages/server/src/skills/mma-flow/SKILL.md', 'plugin/commands/flow.md']) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('Record Integration');
      expect(text).toMatch(/D1\/D3[\s\S]*B2[\s\S]*B5[\s\S]*B6\/B7[\s\S]*B10/);
      expect(text).toContain('.mma/verifications');
      expect(text).toMatch(/supplement/i);
    }
  });
});
/**
 * Retired ENGINE COMPONENTS must not survive in the text sent to a worker.
 *
 * These are prompts, not comments: a skill that tells the implementer its output will be "merged
 * by a downstream annotator", or that a "SPEC reviewer" then a "QUALITY reviewer" then an
 * "annotator" run after its turn, is describing a pipeline that has not existed since the
 * lifecycle layer was removed. The engine runs exactly two phases — implementer, then one
 * reviewer — and creates no worktree, because the caller owns the branch.
 *
 * Nine `worktree` references across five review skills, and three descriptions of the retired
 * multi-stage pipeline, survived until this sweep. Each was read by a live model on every run.
 */
describe('contract: skills describe the pipeline that exists', () => {
  const RETIRED = [
    { term: 'worktree', because: 'the engine creates none — the caller owns the branch and work happens in the submitted cwd' },
    { term: 'annotator', because: 'the annotating stage was removed with the lifecycle layer' },
    { term: 'annotating stage', because: 'the annotating stage was removed with the lifecycle layer' },
    // Banned outright rather than only in the affirmative: a prompt that has to DENY a stage
    // is still describing one. The accurate sentence ("you get exactly one turn") needs neither.
    { term: 'rework round', because: 'there is one reviewer pass, and no stage by this name' },
    { term: 'QUALITY reviewer', because: 'there is one reviewer, not a spec/quality pair' },
    { term: 'SPEC reviewer', because: 'there is one reviewer, not a spec/quality pair' },
  ];

  it.each(RETIRED)('no skill mentions "$term" — $because', async ({ term }) => {
    const { readdir, readFile } = await import('node:fs/promises');
    const root = 'packages/core/src/skills';
    const offenders: string[] = [];
    for (const dir of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
      for (const file of (await readdir(`${root}/${dir.name}`)).filter((f) => f.endsWith('.md'))) {
        const text = await readFile(`${root}/${dir.name}/${file}`, 'utf8');
        if (text.toLowerCase().includes(term.toLowerCase())) offenders.push(`${dir.name}/${file}`);
      }
    }
    expect(offenders, `retired term "${term}" in: ${offenders.join(', ')}`).toEqual([]);
  });
});
