import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

describe('wire schema version contract', () => {
  it('SCHEMA_VERSION is pinned at 6', () => {
    expect(SCHEMA_VERSION).toBe(6);
  });

  // `schemaVersion` is NOT a field of the task-completed event. It belongs to the telemetry BATCH
  // envelope the flusher groups records into (`packages/server/src/telemetry/flusher.ts`), and the
  // wire-field list is asserted in `privacy-doc-sync.test.ts`.
  //
  // A test here used to parse `{ schemaVersion: 6 }` against the event schema and, in its else
  // branch, look for a `schemaVersion` issue. A schema without that field can never raise one, so
  // the assertion was `expect(undefined).toBeUndefined()` — it passed while asserting nothing, and
  // would have kept passing if the wire schema were deleted outright. Removed rather than repaired:
  // the constant is pinned above, and the field is covered where it actually lives.
  it('does not carry schemaVersion on the event record itself', () => {
    const parsed = ValidatedTaskCompletedEventSchema.safeParse({ schemaVersion: 6 });
    expect(parsed.success).toBe(false); // a bare version stamp is not a valid event
  });
});
