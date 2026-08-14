import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_OPERATIONS,
  INITIATIVE_SCHEMA_VERSION,
  InitiativeRecordStore,
  loadMethodGuidance,
  runInitiativeMigrations,
} from '../../packages/core/src/initiative-record/index.js';
import { TASK_TYPES } from '../../packages/core/src/unified/type-registry.js';

const METHOD_IDS = ['architecture-review@1', 'intent-to-initiative@1', 'regulatory-assessment@1', 'research@1', 'risk-analysis@1', 'software-change@1', 'solution-design@1', 'source-validation@1', 'technical-writing@1', 'workflow-design@1'];
const TASK_TYPE_IDS = ['audit', 'investigate', 'delegate', 'execute_plan', 'review', 'debug', 'research', 'journal_recall', 'journal_record', 'orchestrate', 'spec', 'plan'];

describe('SPEC-006 Method catalog', () => {
  it('upgrades v5 to the closed ten-Method catalog and preserves the twelve task routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-spec006-method-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      store.close();
      const db = new DatabaseSync(dbPath);
      db.prepare('DELETE FROM methods WHERE id = ?').run('intent-to-initiative@1');
      db.exec('PRAGMA user_version = 5');
      db.close();
      runInitiativeMigrations({ dbPath });
      const upgraded = InitiativeRecordStore.open({ dbPath });
      // SPEC-007 (Task I-1) added migration version 7 after this v5 database's target v6, so a
      // v5 database now upgrades through v6, v7, and v8, landing on the current
      // INITIATIVE_SCHEMA_VERSION rather than the v6 this check originally pinned.
      expect(INITIATIVE_SCHEMA_VERSION).toBe(8);
      expect(upgraded.listMethods().map((method) => method.id).sort()).toEqual(METHOD_IDS);
      upgraded.close();
      const guidance = loadMethodGuidance('intent-to-initiative@1');
      expect(guidance).toMatch(/necessary question/i);
      expect(guidance).toMatch(/human confirmation/i);
      expect(guidance).toMatch(/must not create record entit/i);
      // FR-2 requires the "Draft completeness" section to enumerate all ten draft fields by
      // name — a loose keyword match (e.g. matching only "draft" or "complete") would pass even
      // when specific fields like Scope or Risks are never mentioned. Assert each field name
      // individually, scoped to the "Draft completeness" section body.
      const draftCompletenessSection =
        guidance.match(/^#{1,6} Draft completeness\s*\n([\s\S]*?)(?=^#{1,6} |(?![\s\S]))/im)?.[1] ?? '';
      // `\s+` (not a literal space) between words of a phrase, because the source guidance.md is
      // hand-wrapped prose — a phrase can legitimately break across a line wrap.
      const requiredDraftFields = [
        /\bGoal\b/,
        /\bScope\b/,
        /candidate\s+Workspaces/i,
        /required\s+Resources/i,
        /\bRequirements\b/,
        /Acceptance\s+Criteria/i,
        /\bRisks\b/,
        /suggested\s+Lifecycle\s+Contract/i,
        /suggested\s+Delivery\s+target/i,
        /open\s+questions/i,
      ];
      for (const fieldPattern of requiredDraftFields) {
        expect(
          draftCompletenessSection,
          `intent-to-initiative@1 "Draft completeness" section missing FR-2 draft field matching ${fieldPattern}`,
        ).toMatch(fieldPattern);
      }
      expect(TASK_TYPES).toEqual(TASK_TYPE_IDS);
      expect(INITIATIVE_OPERATIONS).not.toEqual(expect.arrayContaining(['method_register', 'method_update', 'method_delete']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
