import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

describe('wire schema version contract', () => {
  it('SCHEMA_VERSION is pinned at 6', () => {
    expect(SCHEMA_VERSION).toBe(6);
  });

  it('wire schema accepts schemaVersion=6 in a minimal record', () => {
    const result = ValidatedTaskCompletedEventSchema.safeParse({ schemaVersion: 6 });
    if (result.success) {
      expect(result.data.schemaVersion).toBe(6);
    } else {
      const schemaVersionError = result.error.issues.find(i => i.path.includes('schemaVersion'));
      expect(schemaVersionError).toBeUndefined();
    }
  });
});
