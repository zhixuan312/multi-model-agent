import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';
import { seedResumeFixture } from './fixtures/resume-seed.js';

describe('TEST-001: Initiative resume survives a fresh runtime', () => {
  it('returns the complete pinned InitiativeResumeResponse for one persisted Initiative', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-initiative-resume-'));
    const first = InitiativeRecordRuntime.open({ stateDir });
    try {
      const seeded = seedResumeFixture(first);
      first.close();
      const fresh = InitiativeRecordRuntime.open({ stateDir });
      try {
        expect(fresh.initiativeResume({ initiative: { human_key: seeded.initiative.human_key }, event_limit: 100 })).toEqual(seeded.expectedResume);
        expect(() => fresh.initiativeResume({ initiative: { uuid: seeded.initiative.uuid, human_key: seeded.initiative.human_key } })).toThrow(/invalid_request/);
        expect(() => fresh.initiativeResume({ initiative: { human_key: seeded.initiative.human_key }, event_limit: 101 })).toThrow(/invalid_request/);
      } finally { fresh.close(); }
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});