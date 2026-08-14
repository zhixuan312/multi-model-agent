// Supplementary to the plan-authored tests/initiative-record/initiative-runtime-resume.test.ts:
// covers InitiativeRecordRuntime contract clauses that acceptance test does not exercise —
// read-only execute() dispatch, execute() rejecting `initiative_resume`, typed-error passthrough
// (not_found, revision_conflict), idempotent close(), and initiativeResume's own not_found path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u1',
  interface: 'http',
  initiated_by: 'u1',
  authorized_by: 'u1',
  timestamp: '2026-08-12T00:00:00.000Z',
  source: 'manual',
};

function openRuntime() {
  const stateDir = mkdtempSync(join(tmpdir(), 'mma-initiative-runtime-execute-'));
  const runtime = InitiativeRecordRuntime.open({ stateDir });
  return {
    runtime,
    cleanup: () => {
      runtime.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

describe('InitiativeRecordRuntime execute()', () => {
  it('dispatches every read-only operation to the matching store method', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      const product = runtime.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
      const workspace = runtime.execute({
        operation: 'workspace_create',
        input: { product_id: product.uuid, name: 'Engine', slug: 'engine', description: 'd' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const resource = runtime.execute({
        operation: 'resource_register',
        input: { workspace_id: workspace.uuid, type: 'git_repository', canonical_locator: 'repo', description: 'd' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const initiative = runtime.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const task = runtime.execute({
        operation: 'initiative_task_create',
        input: {
          initiative_id: initiative.uuid,
          title: 'T',
          goal: 'g',
          status: 'open',
          outcome: null,
          workspace_ids: [workspace.uuid],
          resource_ids: [resource.uuid],
        },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const artifact = runtime.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', description: 'd' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };

      expect(runtime.execute({ operation: 'product_get', input: { uuid: product.uuid } })).toEqual(product);
      expect(runtime.execute({ operation: 'product_list', input: {} })).toEqual([product]);
      expect(runtime.execute({ operation: 'workspace_get', input: { uuid: workspace.uuid } })).toEqual(workspace);
      expect(runtime.execute({ operation: 'workspace_list', input: { product_id: product.uuid } })).toEqual([workspace]);
      expect(runtime.execute({ operation: 'resource_list', input: { workspace_id: workspace.uuid } })).toEqual([resource]);
      expect(runtime.execute({ operation: 'initiative_get', input: { uuid: initiative.uuid } })).toEqual(initiative);
      expect(runtime.execute({ operation: 'initiative_list', input: {} })).toEqual([initiative]);
      expect(runtime.execute({ operation: 'initiative_relations', input: { initiative_id: initiative.uuid } })).toEqual([]);
      expect(runtime.execute({ operation: 'initiative_task_get', input: { uuid: task.uuid } })).toEqual(task);
      expect(runtime.execute({ operation: 'initiative_task_list', input: { initiative_id: initiative.uuid } })).toEqual([task]);
      expect(runtime.execute({ operation: 'artifact_get', input: { uuid: artifact.uuid } })).toEqual(artifact);
    } finally {
      cleanup();
    }
  });

  it('rejects initiative_resume as an execute() operation with invalid_request before any store call', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(() => runtime.execute({ operation: 'initiative_resume', input: { initiative: { uuid: '00000000-0000-0000-0000-000000000000' } } })).toThrow(
        /invalid_request/,
      );
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed execute() body with invalid_request before any store call', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(() => runtime.execute({ operation: 'product_create', input: { name: 'MMA' } })).toThrow(/invalid_request/);
      expect(() => runtime.execute({ operation: 'not_a_real_operation', input: {} })).toThrow(/invalid_request/);
    } finally {
      cleanup();
    }
  });

  it('passes core typed errors through unchanged: not_found and revision_conflict', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(() => runtime.execute({ operation: 'product_get', input: { uuid: '00000000-0000-0000-0000-000000000000' } })).toThrow(/not_found/);

      const product = runtime.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance });
      expect(() =>
        runtime.execute({ operation: 'product_create', input: { name: 'MMA 2', slug: 'mma-2' }, expected_revision: 1, provenance }),
      ).toThrow(/revision_conflict/);
      void product;
    } finally {
      cleanup();
    }
  });

  it('close() is idempotent', () => {
    const { runtime, cleanup } = openRuntime();
    runtime.close();
    runtime.close();
    cleanup();
  });
});

describe('InitiativeRecordRuntime initiativeResume()', () => {
  it('throws not_found for an unknown Initiative before assembling any partial response', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(() => runtime.initiativeResume({ initiative: { uuid: '00000000-0000-0000-0000-000000000000' } })).toThrow(/not_found/);
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed resume request (both uuid and human_key) with invalid_request', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(() =>
        runtime.initiativeResume({ initiative: { uuid: '00000000-0000-0000-0000-000000000000', human_key: 'MMA-INIT-1' } }),
      ).toThrow(/invalid_request/);
    } finally {
      cleanup();
    }
  });

  it('rejects an event_limit above 100 with invalid_request', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      const product = runtime.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = runtime.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { human_key: string };
      expect(() => runtime.initiativeResume({ initiative: { human_key: initiative.human_key }, event_limit: 101 })).toThrow(
        /invalid_request/,
      );
    } finally {
      cleanup();
    }
  });
});
