/**
 * A prompt must not instruct the worker to emit a shape the parser discards.
 *
 * `review`'s pair told the worker to put pre-existing defects in "their own 'Pre-existing — out of
 * scope' section" (implementer, three places) and to "move pre-existing bugs to `preExisting`"
 * (refiner, twice). Neither exists. `preExisting` is a BOOLEAN ON EACH FINDING
 * (`refiner-schemas.ts`), the output is a single JSON block so a prose section is discarded by
 * `extractStructuredBlock`, and a top-level `preExisting` array is silently stripped because the
 * Zod object is non-strict.
 *
 * So the review's own stated-critical distinction — did this change introduce the defect, or was it
 * already there — was instructed in a form that threw the pre-existing half away. Nothing errored:
 * the run succeeded with those defects simply absent.
 *
 * This checks the specific field-shape confusions that caused it, by reading the schema rather
 * than restating it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const IMPLEMENT = 'packages/core/src/skills/review/implement.md';
const REVIEW = 'packages/core/src/skills/review/review.md';
const SCHEMAS = 'packages/core/src/unified/refiner-schemas.ts';

const implement = readFileSync(IMPLEMENT, 'utf8');
const review = readFileSync(REVIEW, 'utf8');
const schemas = readFileSync(SCHEMAS, 'utf8');

describe('the review prompts emit the shape the parser accepts', () => {
  it('preExisting is a per-finding boolean in the schema', () => {
    // The premise. If it ever becomes a container, these assertions are the wrong shape and should
    // be revisited rather than deleted.
    expect(schemas).toMatch(/preExisting:\s*z\.boolean\(\)/);
  });

  it.each([
    ['implement.md', implement],
    ['review.md', review],
  ])('%s never sends pre-existing defects to a separate section or container', (_name, text) => {
    // The exact phrasings that instructed an unparseable shape.
    expect(text).not.toMatch(/Pre-existing — out of scope/);
    expect(text).not.toMatch(/(?:go in|move .* to) `preExisting`/i);
    expect(text).not.toMatch(/separated into their own section/i);
  });

  it.each([
    ['implement.md', implement],
    ['review.md', review],
  ])('%s tells the worker to use the boolean instead', (name, text) => {
    expect(text, `${name} never mentions the flag that carries the distinction`)
      .toMatch(/preExisting['"`:\s]*true/);
  });

  it('the refiner is told to flag rather than delete', () => {
    // "Remove pre-existing bugs" would lose them just as surely as moving them to a phantom
    // container — the failure mode is the same, only the instruction differs.
    expect(review).not.toMatch(/(?:remove|delete) pre-existing/i);
  });
});
