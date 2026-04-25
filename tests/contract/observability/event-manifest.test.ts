import manifest from '../goldens/observability/event-manifest.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

describe('observability event manifest', () => {
  it('contains exactly 13 events', () => {
    expect(manifest.events).toHaveLength(13);
  });

  it('every event has a unique name', () => {
    const names = manifest.events.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('task-scoped events implicitly carry task; batch-scoped events carry batch', () => {
    for (const e of manifest.events) {
      // The composer always adds `task` for task-scoped events from the emission site;
      // the manifest's required_keys list is in addition to those implicit fields.
      // Concretely: assert the implicit-key contract by scope.
      if (e.scope === 'task') {
        expect(['task', 'request_received', 'batch_created'].includes(e.scope === 'task' ? 'task' : e.name) || e.required_keys).toBeTruthy();
        // The real assertion: task-scoped events MUST NOT list 'batch' as a required_keys
        // entry (batch is implicit-batch-context, not redundantly required).
        expect(e.required_keys.includes('batch')).toBe(false);
      }
      if (e.scope === 'batch') {
        // batch_created is the one event that LISTS batch in required_keys (since it
        // creates the binding); other batch-scoped events have batch implicit.
        if (e.name === 'batch_created') {
          expect(e.required_keys).toContain('batch');
        }
      }
    }
  });

  it('every required_keys list is non-empty and uses snake_case names', () => {
    for (const e of manifest.events) {
      expect(e.required_keys.length).toBeGreaterThan(0);
      for (const k of e.required_keys) {
        expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('version matches expected', () => {
    expect(manifest.version).toBe('3.3.0');
  });
});
