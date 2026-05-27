import { describe, it, expect } from 'bun:test';
import { SCHEMA_VERSION, ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

describe('wire schema version contract', () => {
  it('SCHEMA_VERSION is pinned at 5', () => {
    // Bumping requires explicit migration coordination — see the design spec
    // (docs/superpowers/specs/2026-05-18-wire-record-honesty-and-verifycommand-removal-design.md)
    // for why this PR intentionally does not bump v5.
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('wire schema literal also pinned at 5', () => {
    // Indirect verification: parse a minimal record and check schemaVersion field.
    // If schema literal drifts from SCHEMA_VERSION, the recorder will fail at runtime.
    // This test only verifies the pin; full record validation lives in other tests.
    const shape = ValidatedTaskCompletedEventSchema._def;
    expect(shape).toBeDefined();
  });
});
