// MMA Next gap-closure (§15: "verification_run is absent" beside verification_record) — GAP 3
// regression. Before this change, `verification_run` did not exist anywhere in
// `INITIATIVE_OPERATIONS`, so every call below throws `invalid_request: unsupported mutation
// operation` against the pre-fix code. It passes once the operation, schema, store mutation
// (command execution + persistence), and dispatch wiring exist.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_OPERATIONS,
  InitiativeRecordStore,
} from '../../packages/core/src/initiative-record/index.js';
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

function seedCriterion(store: InitiativeRecordStore, dir: string) {
  const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
  const initiative = store.execute({
    operation: 'initiative_create',
    input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
    expected_revision: 0,
    provenance,
  }) as { uuid: string };
  const requirement = store.execute({
    operation: 'requirement_add',
    input: { initiative_id: initiative.uuid, statement: 'The engine must run declared verification commands.' },
    expected_revision: 0,
    provenance,
  }) as { uuid: string };
  const criterion = store.execute({
    operation: 'acceptance_criterion_add',
    input: { requirement_id: requirement.uuid, statement: 'A passing command yields state pass.', check_reference: 'verification-run.contract.test.ts' },
    expected_revision: 0,
    provenance,
  }) as { uuid: string };
  // A verification_run is CONFINED to the Initiative's own workspace (audit M1-1): without a
  // Resource declaring a local path there is nowhere safe to run, and the store refuses. Seed one.
  const workspace = store.execute({
    operation: 'workspace_create',
    input: { product_id: product.uuid, name: 'W', slug: 'w', description: 'Workspace the verification runs inside.' },
    expected_revision: 0,
    provenance,
  }) as { uuid: string };
  store.execute({
    operation: 'resource_register',
    input: { workspace_id: workspace.uuid, type: 'repository', canonical_locator: 'https://example.test/w', local_path: dir, description: 'Local checkout the command runs in.' },
    expected_revision: 0,
    provenance,
  });
  store.execute({
    operation: 'initiative_link_workspace',
    input: { initiative_id: initiative.uuid, workspace_id: workspace.uuid, role: 'modifies' },
    expected_revision: 0,
    provenance,
  });
  return { initiative, criterion };
}

describe('MMA Next gap-closure — verification_run (GAP 3)', () => {
  it('is a member of the frozen operation surface with the pinned event type and payload keys', () => {
    expect(INITIATIVE_OPERATIONS).toContain('verification_run');
    expect(INITIATIVE_EVENT_TYPES.verification_run).toBe('verification_run_executed');
    expect(INITIATIVE_EVENT_PAYLOAD_KEYS.verification_run_executed).toEqual([
      'uuid',
      'initiative_id',
      'acceptance_criterion_id',
      'method',
      'state',
    ]);
  });

  it('executes a command, capturing pass/fail from its exit status, and supersedes the prior run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-verification-run-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const { initiative, criterion } = seedCriterion(store, dir);

      const passed = store.execute({
        operation: 'verification_run',
        input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', command: 'true' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; state: string; method: string; detail: string };
      expect(passed.state).toBe('pass');
      expect(passed.method).toBe('command');
      expect(passed.detail).toContain('exit 0');

      const failed = store.execute({
        operation: 'verification_run',
        input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', command: 'false' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; state: string; detail: string };
      expect(failed.state).toBe('fail');
      // `false` exits 1. The command is argv, not a shell program, so an exit code is the only
      // signal a failing check can send — there is no `; exit 3` to interpret (audit M1-1).
      expect(failed.detail).toContain('exit 1');

      // A shell command that cannot even be found (exit 127) is a legitimate FAIL, not
      // A command that does not exist is 'blocked', not 'fail'. Under the old `shell: true` form
      // the SHELL launched fine and reported "command not found" as exit 127, so a misspelled
      // verification command was recorded as a genuine test failure — indistinguishable from the
      // code actually being broken. Without a shell the spawn itself fails, which is the honest
      // signal: the check could not be RUN, as opposed to ran and failed (audit M1-1).
      const notFound = store.execute({
        operation: 'verification_run',
        input: {
          initiative_id: initiative.uuid,
          acceptance_criterion_id: criterion.uuid,
          method: 'command',
          command: 'mma-verification-run-contract-test-nonexistent-command-xyz',
        },
        expected_revision: 0,
        provenance,
      }) as { state: string; detail: string };
      expect(notFound.state).toBe('blocked');
      expect(notFound.detail).toContain('could not be executed');

      // The first ('pass') run must have been superseded by the second ('fail') run for the
      // same Acceptance Criterion — the same automatic-supersede rule `verification_record`
      // already applies.
      const superseded = store.getVerificationRun({ uuid: passed.uuid });
      expect(superseded.state).toBe('superseded');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects 'agent-review' and 'human' as not machine-runnable, before any write, and dispatches through the server runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-verification-run-not-runnable-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const { initiative, criterion } = seedCriterion(store, dir);
      store.close();

      // Route through the SERVER RUNTIME, not store.execute() directly, to prove
      // `verification_run` joined EXECUTE_OPERATIONS and the runtime dispatch switch.
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      try {
        expect(() =>
          runtime.execute({
            operation: 'verification_run',
            input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'agent-review', command: 'true' },
            expected_revision: 0,
            provenance,
          }),
        ).toThrow(/verification_method_not_runnable/);
        expect(() =>
          runtime.execute({
            operation: 'verification_run',
            input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'human', command: 'true' },
            expected_revision: 0,
            provenance,
          }),
        ).toThrow(/verification_method_not_runnable/);
        expect(runtime.execute({ operation: 'verification_list', input: { acceptance_criterion_id: criterion.uuid } })).toEqual([]);

        const passed = runtime.execute({
          operation: 'verification_run',
          input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', command: 'true' },
          expected_revision: 0,
          provenance,
        }) as { state: string };
        expect(passed.state).toBe('pass');
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-Initiative Acceptance Criterion the same way verification_record does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-verification-run-cross-initiative-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const { criterion } = seedCriterion(store, dir);
      const product = store.execute({ operation: 'product_create', input: { name: 'Other', slug: 'other' }, expected_revision: 0, provenance }) as { uuid: string };
      const otherInitiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'Other', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      expect(() =>
        store.execute({
          operation: 'verification_run',
          input: { initiative_id: otherInitiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', command: 'true' },
          expected_revision: 0,
          provenance,
        }),
      ).toThrow(/cross_initiative_verification/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
