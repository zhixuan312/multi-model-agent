/**
 * No skill may promise a per-file fan-out, because the engine has none.
 *
 * `mma-review` claimed "Each file is reviewed independently in parallel; results are index-aligned
 * with `target.paths`" — in the body, in its `description`, and in its `when_to_use`, i.e. the two
 * fields a routing agent reads before choosing it. `mma-audit` carried the same mechanism ("the
 * per-file parallel split degenerates to one worker") while contradicting itself four lines from
 * its own "one audit per dispatch" row.
 *
 * There is no such split anywhere: `ExecutionRuntime` makes ONE `runTwoPhasePipeline` call per
 * submission, and that pipeline opens exactly one implementer and one reviewer session. The
 * response carries a single `findings` array, not one per path.
 *
 * The cost was not a failed call but a mis-sized one: a caller told each file gets its own worker
 * passes twenty paths and gets one turn's attention spread across all of them, with no way to tell
 * from the response that this happened.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = 'packages/server/src/skills';

const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== '_shared')
  .map((e) => join(SKILLS_DIR, e.name, 'SKILL.md'));

/** Phrasings that promise the engine splits one dispatch across workers. */
const FANOUT_CLAIMS: Array<[label: string, pattern: RegExp]> = [
  ['reviewed/audited in parallel per file', /(?:each|per)[- ]file[^.\n]{0,40}\bparallel\b/i],
  ['results index-aligned with target.paths', /index-aligned/i],
  ['each file gets its own worker', /each file[^.\n]{0,40}\bown worker\b/i],
  ['a per-file split', /per-file (?:parallel )?split/i],
];

describe('no skill claims a per-file fan-out', () => {
  it('finds the skills', () => {
    expect(skillFiles.length).toBeGreaterThan(15);
  });

  it.each(skillFiles)('%s promises no fan-out the engine cannot perform', (file) => {
    const text = readFileSync(file, 'utf8');
    const claimed = FANOUT_CLAIMS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
    expect(claimed, `${file} promises: ${claimed.join('; ')}`).toEqual([]);
  });

  it('the engine really does run one pipeline per submission', () => {
    // The premise. If this ever stops holding, the assertions above are the wrong shape and
    // should be revisited rather than deleted.
    const runtime = readFileSync('packages/server/src/application/execution-runtime.ts', 'utf8');
    const calls = runtime.match(/await runTwoPhasePipeline\(/g) ?? [];
    expect(calls, 'more than one pipeline call — does a fan-out exist now?').toHaveLength(1);
  });
});
