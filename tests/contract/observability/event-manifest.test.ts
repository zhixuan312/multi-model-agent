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

  it('schemaVersion matches expected', () => {
    expect(manifest.schemaVersion).toBe(2);
  });
});

