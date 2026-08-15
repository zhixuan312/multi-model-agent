import manifest from '../goldens/observability/event-manifest.json' with { type: 'json' };
import { PlainLogKindEnum, PROVIDER_EVENT_NAMES } from '../../../packages/core/src/events/plain-log-entry.js';
import { describe, expect, it } from 'vitest';

describe('observability event manifest', () => {
  // Set equality, both directions, replacing a manifest ⊆ enum check plus a hardcoded count of
  // 13. That pair let eight emitterless kinds sit in both lists indefinitely — the count agreed
  // with itself, and the subset check agreed with itself. What each name means is checked by
  // `tests/events/plain-log-emitter-reachability.test.ts`: it must have a production emitter.
  it('lists exactly the kinds PlainLogKindEnum declares', () => {
    expect(manifest.kinds.map((k) => k.kind).sort()).toEqual([...PlainLogKindEnum.options].sort());
  });

  it('provider_event kind documents the list of valid provider event names', () => {
    const providerEventEntry = manifest.kinds.find((k) => k.kind === 'provider_event');
    expect(providerEventEntry).toBeDefined();
    expect(Array.isArray(providerEventEntry!.provider_events)).toBe(true);
    expect(providerEventEntry!.provider_events.length).toBe(PROVIDER_EVENT_NAMES.length);
    for (const name of PROVIDER_EVENT_NAMES) {
      expect(providerEventEntry!.provider_events).toContain(name);
    }
  });

  it('non-provider_event kinds have empty provider_events array', () => {
    for (const kindEntry of manifest.kinds) {
      if (kindEntry.kind !== 'provider_event') {
        expect(Array.isArray(kindEntry.provider_events)).toBe(true);
        expect(kindEntry.provider_events).toHaveLength(0);
      }
    }
  });

  it('every kind has a unique name', () => {
    const kinds = manifest.kinds.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  /**
   * `schemaVersion` is not read by any code — it exists in this golden and nowhere else. The old
   * assertion was `expect(manifest.schemaVersion).toBe(2)`: one hand-maintained literal compared to
   * another, in two files edited by the same person in the same commit. It could only fail if
   * someone changed one and forgot the other, and it said nothing about the manifest.
   *
   * A schema version is supposed to protect a SHAPE, so this checks the shape and ties the version
   * to it. Change the manifest's structure and the key assertion fails, which is the moment to
   * decide whether the version should move; leave the structure alone and the version is free to
   * stay put. That is the relationship the field was always claiming to have.
   */
  it('the manifest has the shape its schemaVersion names', () => {
    expect(Object.keys(manifest).sort()).toEqual(['kinds', 'schemaVersion']);
    expect(typeof manifest.schemaVersion).toBe('number');
    // Five kinds today. The floor is what stops an empty `kinds` array from satisfying the
    // per-entry loop below by having no entries to check.
    expect(manifest.kinds.length, 'an empty manifest passes every other case here')
      .toBeGreaterThanOrEqual(5);
    for (const entry of manifest.kinds) {
      expect(
        Object.keys(entry).sort(),
        `manifest entry ${entry.kind} has unexpected keys — bump schemaVersion if this is intended`,
      ).toEqual(['kind', 'provider_events']);
    }
  });
});

