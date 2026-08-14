import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, registerTargetAdapter } from '../../packages/core/src/initiative-record/index.js';

const MARKER = 'spec007-test-only-fake-adapter';
const provenance = { actor_type: 'agent', actor_id: 'test', interface: 'test', initiated_by: 'test', authorized_by: 'test', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };
function nonTestSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return nonTestSourceFiles(path);
    return /\.(?:ts|mts|cts)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

describe('SPEC-007 fake adapter capability proof', () => {
  it('changes a complete Deliverable only after public adapter registration and keeps the marker out of core', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-fake-adapter-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      let revision = 0;
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: revision, provenance }) as { uuid: string; revision: number };
      revision = deliverable.revision;
      for (const requirement of ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence']) {
        const artifact = store.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement }, expected_revision: 0, provenance }) as { uuid: string };
        const attached = store.execute({ operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement }, expected_revision: revision, provenance }) as { revision: number };
        revision = attached.revision;
      }
      const baseline = store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: revision, provenance }) as { validation_state: string; revision: number };
      expect(baseline.validation_state).toBe('valid');
      registerTargetAdapter({ target_type: 'runnable-prototype', validate: () => ({ valid: false, detail: MARKER }) });
      const changed = store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: baseline.revision, provenance }) as { validation_state: string };
      expect(changed.validation_state).toBe('invalid');
      const coreRoot = resolve(import.meta.dirname, '../../packages/core/src');
      expect(nonTestSourceFiles(coreRoot).filter((path) => readFileSync(path, 'utf8').includes(MARKER))).toEqual([]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});