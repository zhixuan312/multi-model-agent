import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';
import { seedResumeFixture } from './fixtures/resume-seed.js';

/**
 * TEST-001, and the Phase A1 resume-golden acceptance check, which used to be a second file.
 *
 * `a1-resume-golden.check.test.ts` seeded the same 888-line fixture through the same real runtime,
 * reopened the same SQLite state dir, and asserted `toEqual(seeded.expectedResume)` — the identical
 * assertion made below. Its three follow-up checks (the response key set, the
 * `verification_by_state` key set, and every acceptance criterion's `requirement_id` matching its
 * requirement) are all IMPLIED by that `toEqual`: it is strict both ways, so an extra key, a
 * missing key or a wrong id already fails it. Two full seeds, two runtime open/close pairs, one
 * test's worth of coverage.
 *
 * They are kept below anyway, as named statements of the contract a reader can check against the
 * acceptance criterion without reading the fixture — which is the only thing that file contributed.
 */
describe('TEST-001: Initiative resume survives a fresh runtime', () => {
  it('returns the complete pinned InitiativeResumeResponse for one persisted Initiative', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-initiative-resume-'));
    const first = InitiativeRecordRuntime.open({ stateDir });
    try {
      const seeded = seedResumeFixture(first);
      first.close();
      const fresh = InitiativeRecordRuntime.open({ stateDir });
      try {
        const response = fresh.initiativeResume({ initiative: { human_key: seeded.initiative.human_key }, event_limit: 100 });
        expect(response).toEqual(seeded.expectedResume);

        // The shape, stated by name — see the note above on why these follow rather than add.
        expect(Object.keys(response).sort()).toEqual(['artifacts', 'counts', 'decisions', 'deliverables', 'events', 'evidence', 'initiative', 'lifecycle', 'product', 'related_initiatives', 'requirements', 'risks', 'tasks', 'verification', 'workspaces']);
        expect(Object.keys(response.counts.verification_by_state).sort()).toEqual(['blocked', 'fail', 'needs_human_review', 'not_applicable', 'pass', 'pending', 'stale', 'superseded']);
        expect(response.requirements.every((entry) => entry.acceptance_criteria.every((criterion) => criterion.requirement_id === entry.requirement.uuid))).toBe(true);

        expect(() => fresh.initiativeResume({ initiative: { uuid: seeded.initiative.uuid, human_key: seeded.initiative.human_key } })).toThrow(/invalid_request/);
        expect(() => fresh.initiativeResume({ initiative: { human_key: seeded.initiative.human_key }, event_limit: 101 })).toThrow(/invalid_request/);
      } finally { fresh.close(); }
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});