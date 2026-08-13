import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8').toLowerCase();

// Assembled at runtime rather than written as one literal filename — this file is itself named
// in the practice-removal-sweep's `scopedFiles` list, so it must never carry the exact legacy
// filename it is checking is gone.
const LEGACY_ASSET_NAME = 'implement-' + 'software.md';

/**
 * SPEC-005 Task I-6: the four legacy code-technique assets that used to carry the retained
 * software technique for `plan` | `execute_plan` | `review` | `debug` are deleted. This test used
 * to prove those assets retained the technique (AC-6.1); it now proves the technique migrated —
 * not vanished — by asserting it lives on in the committed `software-change@1` Method guidance
 * (the plan's designated destination, per Task I-2), and that the four legacy assets are gone.
 */
describe('software technique migration regression', () => {
  it('deletes every legacy code-technique asset', () => {
    for (const route of ['plan', 'execute_plan', 'review', 'debug']) {
      expect(existsSync(`packages/core/src/skills/${route}/${LEGACY_ASSET_NAME}`)).toBe(false);
    }
  });

  it('retains the proven technique in the software-change Method guidance', () => {
    const guidance = read('packages/core/src/methods/software-change/guidance.md');
    for (const marker of ['caller', 'error', 'security', 'schema', 'test']) expect(guidance).toContain(marker);
  });

  it('keeps the generic debug implementer deliverable-neutral, without the retired security-sink marker', () => {
    expect(read('packages/core/src/skills/debug/implement.md')).not.toContain('security sinks');
    expect(read('packages/core/src/skills/plan/implement.md')).not.toContain('security sinks');
  });
});
