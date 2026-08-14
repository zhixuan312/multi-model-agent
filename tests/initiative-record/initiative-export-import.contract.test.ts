// MMA Next gap-closure (§15: "initiative_export and initiative_import are absent") — GAP 4
// regression, ← §21 success criterion 12: "an Initiative can be exported to a portable snapshot
// and re-imported". Before this change, neither operation existed anywhere in
// `INITIATIVE_OPERATIONS`, so `initiative_export` throws `invalid_request` (unknown operation,
// never dispatched to `initiativeExport()`) and `initiative_import` throws `invalid_request:
// unsupported mutation operation` against the pre-fix code. Both pass once the operations,
// schemas, store read/mutation, and dispatch wiring exist.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INITIATIVE_EXPORT_SCHEMA_VERSION, INITIATIVE_OPERATIONS } from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = {
  actor_type: 'agent',
  actor_id: 'seed',
  interface: 'test',
  initiated_by: 'seed',
  authorized_by: 'seed',
  timestamp: '2026-08-14T00:00:00.000Z',
  source: 'test',
};

/** Seeds one Initiative touching every exported section at least once: Product, Workspace (with
 *  role + Resource), Task, Artifact, Requirement/AcceptanceCriterion, Decision, Evidence, Risk,
 *  VerificationRun, a Phase Record, and a Deliverable with membership + delivery history. */
function seedFullInitiative(runtime: InitiativeRecordRuntime) {
  let seconds = 0;
  function call<T>(operation: string, input: Record<string, unknown>, expectedRevision = 0): T {
    const stamped = { ...provenance, timestamp: `2026-08-14T00:00:${String(seconds).padStart(2, '0')}.000Z` };
    seconds += 1;
    return runtime.execute({ operation, input, expected_revision: expectedRevision, provenance: stamped }) as T;
  }

  const product = call<{ uuid: string }>('product_create', { name: 'Export Product', slug: 'export-product' });
  const workspace = call<{ uuid: string }>('workspace_create', {
    product_id: product.uuid,
    name: 'Export Workspace',
    slug: 'export-workspace',
    description: 'A workspace touched by every export section.',
  });
  const resource = call<{ uuid: string }>('resource_register', {
    workspace_id: workspace.uuid,
    type: 'repo',
    canonical_locator: 'export-r1',
    description: 'A resource.',
  });
  const initiative = call<{ uuid: string; human_key: string }>('initiative_create', {
    product_id: product.uuid,
    title: 'Export Target',
    goal: 'Prove export/import round-trips.',
    status: 'open',
    outcome: null,
  });
  call('initiative_link_workspace', { initiative_id: initiative.uuid, workspace_id: workspace.uuid, role: 'consumes' });
  const task = call<{ uuid: string }>('initiative_task_create', {
    initiative_id: initiative.uuid,
    title: 'Do the work',
    goal: 'g',
    status: 'open',
    outcome: null,
    workspace_ids: [workspace.uuid],
    resource_ids: [resource.uuid],
  });
  const artifact = call<{ uuid: string }>('artifact_register', {
    initiative_id: initiative.uuid,
    storage_mode: 'managed',
    path_or_uri: 'executable_prototype',
    description: 'An artifact.',
    produced_by_task: task.uuid,
  });
  const requirement = call<{ uuid: string; human_key: string }>('requirement_add', { initiative_id: initiative.uuid, statement: 'Must export.' });
  const criterion = call<{ uuid: string }>('acceptance_criterion_add', {
    requirement_id: requirement.uuid,
    statement: 'Export round-trips.',
    check_reference: 'initiative-export-import.contract.test.ts',
  });
  const decision = call<{ uuid: string }>('decision_record', {
    initiative_id: initiative.uuid,
    title: 'Snapshot shape',
    decision: 'Echo the frozen public shapes.',
    rationale: 'No second schema to drift.',
    alternatives: [],
    status: 'decided',
  });
  const evidence = call<{ uuid: string }>('evidence_add', {
    initiative_id: initiative.uuid,
    kind: 'test-run',
    locator: 'initiative-export-import.contract.test.ts',
    content_hash: null,
    summary: 'This test passes.',
  });
  const risk = call<{ uuid: string }>('risk_add', {
    initiative_id: initiative.uuid,
    statement: 'Round trip drifts silently.',
    severity: 'medium',
    status: 'open',
  });
  const verification = call<{ uuid: string }>('verification_record', {
    initiative_id: initiative.uuid,
    acceptance_criterion_id: criterion.uuid,
    method: 'command',
    state: 'pass',
    detail: 'ok',
  });
  call('initiative_phase_enter', { initiative: { uuid: initiative.uuid }, phase: 'discover' });

  const deliverable = call<{ uuid: string; revision: number }>('deliverable_define', {
    initiative_id: initiative.uuid,
    target_type: 'runnable-prototype',
    delivery_contract: 'runnable-prototype@1',
  });
  call(
    'deliverable_attach_artifact',
    { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement: 'executable_prototype' },
    deliverable.revision,
  );
  // `deliverable_get` is a READ operation — it carries no `expected_revision`/`provenance`, so
  // it is called directly through `runtime.execute()` rather than through the `call()` helper
  // above (which always adds those mutation-control fields).
  const afterAttach = runtime.execute({ operation: 'deliverable_get', input: { uuid: deliverable.uuid } }) as { revision: number };
  call(
    'deliverable_deliver',
    { deliverable_id: deliverable.uuid, delivery_reference: 'https://example.com/prototype.zip' },
    afterAttach.revision,
  );

  return { product, workspace, resource, initiative, task, artifact, requirement, criterion, decision, evidence, risk, verification, deliverable };
}

describe('MMA Next gap-closure — initiative_export / initiative_import (GAP 4)', () => {
  it('is a member of the frozen operation surface', () => {
    expect(INITIATIVE_OPERATIONS).toEqual(expect.arrayContaining(['initiative_export', 'initiative_import']));
  });

  it('exports a self-contained, schema-stamped snapshot naming every documented section', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-export-'));
    try {
      const runtime = InitiativeRecordRuntime.open({ stateDir });
      try {
        const seeded = seedFullInitiative(runtime);
        const snapshot = runtime.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });

        expect(snapshot.schema_version).toBe(INITIATIVE_EXPORT_SCHEMA_VERSION);
        expect(typeof snapshot.exported_at).toBe('string');
        expect(snapshot.initiative.uuid).toBe(seeded.initiative.uuid);
        expect(snapshot.product.uuid).toBe(seeded.product.uuid);
        expect(snapshot.workspaces).toHaveLength(1);
        expect(snapshot.workspaces[0]!.link).toMatchObject({ initiative_id: seeded.initiative.uuid, workspace_id: seeded.workspace.uuid, role: 'consumes' });
        expect(snapshot.workspaces[0]!.resources.map((r) => r.uuid)).toEqual([seeded.resource.uuid]);
        expect(snapshot.tasks.map((t) => t.uuid)).toEqual([seeded.task.uuid]);
        expect(snapshot.artifacts.map((a) => a.uuid)).toEqual([seeded.artifact.uuid]);
        expect(snapshot.requirements.map((r) => r.uuid)).toEqual([seeded.requirement.uuid]);
        expect(snapshot.acceptance_criteria.map((c) => c.uuid)).toEqual([seeded.criterion.uuid]);
        expect(snapshot.decisions.map((d) => d.uuid)).toEqual([seeded.decision.uuid]);
        expect(snapshot.evidence.map((e) => e.uuid)).toEqual([seeded.evidence.uuid]);
        expect(snapshot.risks.map((r) => r.uuid)).toEqual([seeded.risk.uuid]);
        expect(snapshot.verification_runs.map((v) => v.uuid)).toEqual([seeded.verification.uuid]);
        expect(snapshot.phase_records).toEqual([{ phase: 'discover', state: 'active' }]);
        expect(snapshot.deliverables).toHaveLength(1);
        expect(snapshot.deliverables[0]!.deliverable.uuid).toBe(seeded.deliverable.uuid);
        expect(snapshot.deliverables[0]!.members).toHaveLength(1);
        expect(snapshot.deliverables[0]!.history).toHaveLength(1);
        expect(snapshot.deliverables[0]!.history[0]).toMatchObject({ delivery_reference: 'https://example.com/prototype.zip' });
        // EvidenceLinks are deliberately not part of the snapshot (same choice
        // InitiativeResumeResponse's `evidence` section already documents).
        expect(snapshot.events.length).toBeGreaterThan(0);
        expect(snapshot.events.every((event) => event.initiative_id === seeded.initiative.uuid)).toBe(true);
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('round-trips CONTENT-equivalent (export -> fresh store -> import -> export)', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'mma-export-source-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'mma-export-target-'));
    try {
      const source = InitiativeRecordRuntime.open({ stateDir: sourceDir });
      let seeded: ReturnType<typeof seedFullInitiative>;
      let firstSnapshot: ReturnType<InitiativeRecordRuntime['initiativeExport']>;
      try {
        seeded = seedFullInitiative(source);
        firstSnapshot = source.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });
      } finally {
        source.close();
      }

      const target = InitiativeRecordRuntime.open({ stateDir: targetDir });
      try {
        const imported = target.execute({
          operation: 'initiative_import',
          input: { snapshot: firstSnapshot },
          expected_revision: 0,
          provenance,
        }) as { uuid: string; human_key: string };
        expect(imported.uuid).toBe(seeded.initiative.uuid);
        expect(imported.human_key).toBe(seeded.initiative.human_key);

        const secondSnapshot = target.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });

        // Assert equivalence on CONTENT, not counts: every section deep-equal after normalizing
        // the two fields that are legitimately NOT portable across stores rather than
        // "content" — the wall-clock `exported_at` stamp (differs between the two assembly
        // calls), and each Event's `event_sequence` (an installation-relative ordinal: the
        // source store already logged `product_created`/`workspace_created`/`resource_registered`
        // Events — which carry no `initiative_id` and so are correctly excluded from this
        // per-Initiative snapshot — BEFORE this Initiative's own Events, so the source's
        // absolute sequence numbers start above 1, while the freshly re-imported target's
        // replayed sequence starts at 1; every event's full CONTENT and RELATIVE order are what
        // must — and do — match).
        const normalize = (snapshot: typeof firstSnapshot) => ({
          ...snapshot,
          exported_at: undefined,
          events: snapshot.events.map((event, index) => ({ ...event, event_sequence: index })),
        });
        expect(normalize(secondSnapshot)).toEqual(normalize(firstSnapshot));

        // A subsequent human-key allocation on the imported Initiative must not collide with an
        // imported human key.
        const secondRequirement = target.execute({
          operation: 'requirement_add',
          input: { initiative_id: seeded.initiative.uuid, statement: 'A post-import Requirement.' },
          expected_revision: 0,
          provenance,
        }) as { human_key: string };
        expect(secondRequirement.human_key).not.toBe(seeded.requirement.human_key);
      } finally {
        target.close();
      }
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('rejects re-importing an Initiative that already exists (conflict), and an unsupported schema_version (validation), leaving the store unchanged', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-export-conflict-'));
    try {
      const runtime = InitiativeRecordRuntime.open({ stateDir });
      try {
        const seeded = seedFullInitiative(runtime);
        const snapshot = runtime.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });

        expect(() =>
          runtime.execute({ operation: 'initiative_import', input: { snapshot }, expected_revision: 0, provenance }),
        ).toThrow(/initiative_already_exists/);

        const unsupported = { ...snapshot, schema_version: snapshot.schema_version + 1000 };
        expect(() =>
          runtime.execute({ operation: 'initiative_import', input: { snapshot: unsupported }, expected_revision: 0, provenance }),
        ).toThrow(/invalid_request/);
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('is an all-or-nothing transaction: a snapshot that fails partway through the write algorithm leaves zero rows behind', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'mma-export-atomicity-source-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'mma-export-atomicity-target-'));
    try {
      const source = InitiativeRecordRuntime.open({ stateDir: sourceDir });
      let seeded: ReturnType<typeof seedFullInitiative>;
      let snapshot: ReturnType<InitiativeRecordRuntime['initiativeExport']>;
      try {
        seeded = seedFullInitiative(source);
        snapshot = source.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });
      } finally {
        source.close();
      }

      // A duplicated Artifact entry is still Zod-valid (the schema does not check array
      // uniqueness), so it reaches the store's raw INSERT sequence — where the SECOND insert
      // for the same `uuid` violates `artifact_refs`'s PRIMARY KEY constraint, well after many
      // prior rows (Product, Workspace, Resource, Initiative, link, Task, the first Artifact
      // copy) have already been written inside the SAME open transaction.
      const poisoned = { ...snapshot, artifacts: [...snapshot.artifacts, snapshot.artifacts[0]!] };

      const target = InitiativeRecordRuntime.open({ stateDir: targetDir });
      try {
        expect(() =>
          target.execute({ operation: 'initiative_import', input: { snapshot: poisoned }, expected_revision: 0, provenance }),
        ).toThrow();

        // Nothing from the failed import survived — not the Initiative, not its Product, not a
        // single replayed Event.
        expect(() => target.execute({ operation: 'initiative_get', input: { uuid: seeded.initiative.uuid } })).toThrow(/not_found/);
        expect(() => target.execute({ operation: 'product_get', input: { uuid: seeded.product.uuid } })).toThrow(/not_found/);
        expect(target.execute({ operation: 'product_list', input: {} })).toEqual([]);

        // A subsequent, unpoisoned import of the SAME snapshot succeeds — the failed attempt
        // left no partial residue for a real import to collide with.
        const imported = target.execute({
          operation: 'initiative_import',
          input: { snapshot },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        expect(imported.uuid).toBe(seeded.initiative.uuid);
      } finally {
        target.close();
      }
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('rejects a structurally valid snapshot whose Initiative-owned row belongs to another Initiative', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'mma-export-ownership-source-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'mma-export-ownership-target-'));
    try {
      const source = InitiativeRecordRuntime.open({ stateDir: sourceDir });
      let seeded: ReturnType<typeof seedFullInitiative>;
      let snapshot: ReturnType<InitiativeRecordRuntime['initiativeExport']>;
      try {
        seeded = seedFullInitiative(source);
        snapshot = source.initiativeExport({ initiative: { uuid: seeded.initiative.uuid } });
      } finally {
        source.close();
      }

      // This still satisfies the wire schema (it is a UUID), but it is not a portable snapshot
      // of ONE Initiative. Without a semantic ownership check import writes the Artifact, then
      // the next export omits it because it no longer belongs to the imported Initiative.
      const crossInitiative = {
        ...snapshot,
        artifacts: snapshot.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, initiative_id: '00000000-0000-0000-0000-000000000001' } : artifact,
        ),
      };

      const target = InitiativeRecordRuntime.open({ stateDir: targetDir });
      try {
        expect(() =>
          target.execute({ operation: 'initiative_import', input: { snapshot: crossInitiative }, expected_revision: 0, provenance }),
        ).toThrow(/invalid_request/);
        expect(() => target.execute({ operation: 'initiative_get', input: { uuid: seeded.initiative.uuid } })).toThrow(/not_found/);
      } finally {
        target.close();
      }
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
