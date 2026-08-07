import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskCompletedEventSchema } from '@zhixuan92/multi-model-agent-core/events/wire-schema';

/**
 * PRIVACY.md must document every field that leaves the machine.
 *
 * DERIVED FROM THE SCHEMA, NOT FROM A LIST. This test used to assert a
 * hand-written array of field names, which can only ever catch a field being
 * REMOVED or renamed — the failure mode that matters is a NEW field reaching
 * the wire undocumented, and a hardcoded list is blind to it by construction.
 * That is not hypothetical: `toolCalls` shipped to master ahead of 6.3.0
 * carrying individual tool names while PRIVACY.md still stated that individual
 * tool names are not transmitted, and this test passed the whole time.
 *
 * Walking the Zod object means adding a field to the wire fails this test until
 * someone writes the corresponding row — which is the only version of this
 * guard worth having.
 */
describe('PRIVACY.md ↔ schema sync', () => {
  const repoRoot = join(__dirname, '..', '..');
  const md = readFileSync(join(repoRoot, 'PRIVACY.md'), 'utf8');

  it('documents every top-level field of the uploaded task.completed event', () => {
    const fields = Object.keys(TaskCompletedEventSchema.shape);
    expect(fields.length, 'schema introspection returned nothing — the shape accessor changed').toBeGreaterThan(10);

    const undocumented = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(md));
    expect(undocumented, `undocumented wire field(s): ${undocumented.join(', ')} — add a row to PRIVACY.md`).toEqual([]);
  });

  it('documents the batch-wrapper fields', () => {
    for (const f of ['installId', 'schemaVersion', 'mmaVersion', 'os', 'nodeMajor', 'eventId']) {
      expect(new RegExp(`\\b${f}\\b`).test(md), `${f} should appear in PRIVACY.md`).toBe(true);
    }
  });

  // A doc can be complete and still be wrong. This pins the one claim that the
  // toolCalls rollup falsified, so re-adding it would fail rather than quietly
  // contradict the schema that sits three files away.
  it('makes no blanket claim that tool names are withheld', () => {
    expect(md).not.toMatch(/individual tool names are not transmitted/i);
  });
});
