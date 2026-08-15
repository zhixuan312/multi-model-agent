/**
 * B2's multi-repo fan-out must thread `outputPath`, and mma-flow must keep saying so.
 *
 * mma-flow's Common: Artifact stem stated, without qualification, that "the flow threads no
 * `outputPath`" — inheritance derives every artifact's name from the dated input. That is true
 * for D3 (one spec) and false for B2 in multi-repo mode, where the SAME spec is dispatched once
 * per repo. Inheritance is a pure function of the input path, so N repos derive N identical
 * paths: `.mma/plans/<stem>.md`. The second dispatch overwrites the first, the third overwrites
 * the second, and nothing anywhere reports it — the engine wrote exactly the file it was asked
 * for, every time. A three-repo flow would reach B5 with one plan on disk and two repos silently
 * planless, and mma-plan's own SKILL.md already documented the fix ("two repo dispatches differ
 * only in repo scope and `outputPath`") while mma-flow told the caller not to.
 *
 * The first half proves the collision is real against the live derivation rather than trusting
 * the prose; the second pins the prose that prevents it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveDefaultOutputPath } from '../../../packages/server/src/application/preprocessors/derive-output-path.js';

const SPEC = '/parent/.mma/specs/2026-08-14-example.md';

describe('contract: mma-flow B2 plan fan-out', () => {
  it('inheritance alone gives every repo the SAME plan path — the collision B2 must avoid', () => {
    // Two dispatches that differ only in the prompt (the repo scope), exactly as mma-plan
    // documents the per-repo fan-out.
    const engine = deriveDefaultOutputPath({
      type: 'plan',
      prompt: 'plan the multi-model-agent slice',
      paths: [SPEC],
      today: '2026-08-15',
    });
    const forge = deriveDefaultOutputPath({
      type: 'plan',
      prompt: 'plan the multi-model-agent-forge slice',
      paths: [SPEC],
      today: '2026-08-15',
    });

    expect(engine).toBe('.mma/plans/2026-08-14-example.md');
    // The point of the test: identical, so the second dispatch overwrites the first.
    expect(forge).toBe(engine);
  });

  it('nothing in the derivation appends a repo slug — only the caller can', () => {
    const derived = deriveDefaultOutputPath({
      type: 'plan',
      prompt: 'plan the multi-model-agent-forge slice',
      paths: [SPEC],
      today: '2026-08-15',
    });
    expect(derived).not.toContain('--');
  });

  it('mma-flow tells the caller to thread outputPath per repo at B2', () => {
    for (const file of [
      'packages/server/src/skills/mma-flow/SKILL.md',
      'plugin/commands/flow.md', // the generated copy ships to the marketplace
    ]) {
      const text = readFileSync(file, 'utf8');
      // The `--<repo-slug>` filename and the field that produces it must both be named, in the
      // same document — the Out row alone described a filename the wiring never asked for.
      expect(text, file).toContain('.mma/plans/<stem>--<repo-slug>.md');
      expect(text, file).toMatch(/multi-repo ONLY: `outputPath`/);
      // And the unqualified claim must not come back.
      expect(text, file).not.toMatch(/the flow threads no `outputPath`/);
    }
  });
});
