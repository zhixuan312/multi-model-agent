import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';
import { seedResumeFixture } from './fixtures/resume-seed.js';

describe('Phase A1 resume golden', () => {
  it('returns the complete professional record and every required count after reopen', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-a1-resume-'));
    const first = InitiativeRecordRuntime.open({ stateDir });
    try {
      const seeded = seedResumeFixture(first);
      first.close();
      const fresh = InitiativeRecordRuntime.open({ stateDir });
      try {
        const response = fresh.initiativeResume({ initiative: { human_key: seeded.initiative.human_key }, event_limit: 100 });
        expect(response).toEqual(seeded.expectedResume);
        expect(Object.keys(response).sort()).toEqual(['artifacts', 'counts', 'decisions', 'events', 'evidence', 'initiative', 'product', 'related_initiatives', 'requirements', 'risks', 'tasks', 'verification', 'workspaces']);
        expect(Object.keys(response.counts.verification_by_state).sort()).toEqual(['blocked', 'fail', 'needs_human_review', 'not_applicable', 'pass', 'pending', 'stale', 'superseded']);
        expect(response.requirements.every((entry) => entry.acceptance_criteria.every((criterion) => criterion.requirement_id === entry.requirement.uuid))).toBe(true);
      } finally { fresh.close(); }
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});