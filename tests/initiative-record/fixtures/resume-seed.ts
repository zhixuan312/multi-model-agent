/**
 * TEST-001 fixture — deterministic public-surface seed for the resume-contract
 * check (Task I-9). Seeds one complete, representative Initiative record using
 * ONLY `InitiativeRecordRuntime.execute()` calls — never the store or SQL
 * directly — then builds the exact expected `InitiativeResumeResponse` the
 * fresh-runtime `initiativeResume()` call must equal.
 *
 * Every stored timestamp (`createdAt`, `updatedAt`, an Event's `timestamp`) is
 * copied verbatim from the mutation's `provenance.timestamp` (the runtime's
 * only clock-injection seam — see `sqlite-store.ts`'s `now = provenance.timestamp`
 * pattern), so supplying one fixed, strictly increasing provenance timestamp per
 * call makes every stored value, and therefore every ordering rule keyed on
 * `createdAt`, deterministic without any wall-clock dependency.
 */
import type { InitiativeRecordRuntime } from '../../../packages/server/src/application/initiative-record-runtime.js';
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Decision,
  Event,
  Evidence,
  Initiative,
  InitiativeRelation,
  InitiativeResumeResponse,
  InitiativeWorkspaceLink,
  LifecycleResumeBlock,
  Product,
  Requirement,
  Resource,
  Risk,
  Task,
  VerificationRun,
  Workspace,
} from '../../../packages/core/src/initiative-record/index.js';

/** Fixed test provenance; only `timestamp` varies per call, one second apart in call order. */
function provenanceAt(seconds: number) {
  return {
    actor_type: 'agent' as const,
    actor_id: 'seed-agent',
    interface: 'test',
    initiated_by: 'seed-agent',
    authorized_by: 'seed-maintainer',
    timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`,
    source: 'fixture',
  };
}

export interface SeedResumeFixtureResult {
  product: Product;
  workspaces: [Workspace, Workspace];
  resources: [Resource, Resource, Resource];
  initiative: Initiative;
  relatedInitiative: Initiative;
  links: [InitiativeWorkspaceLink, InitiativeWorkspaceLink];
  relation: InitiativeRelation;
  tasks: [Task, Task];
  artifacts: [ArtifactRef, ArtifactRef];
  requirements: [Requirement, Requirement];
  criteria: [AcceptanceCriterion, AcceptanceCriterion, AcceptanceCriterion];
  decisions: [Decision, Decision, Decision];
  risks: [Risk, Risk, Risk];
  evidence: [Evidence, Evidence];
  verificationRuns: [VerificationRun, VerificationRun, VerificationRun];
  events: Event[];
  expectedResume: InitiativeResumeResponse;
}

/**
 * Seeds Product -> two Workspaces -> Resources -> the target Initiative -> a
 * related Initiative -> two Workspace links -> one relation -> a non-terminal
 * and a terminal Task -> two external ArtifactRefs, entirely through
 * `runtime.execute()`, and returns both the created source records and the
 * complete expected `initiative_resume` payload for the target Initiative.
 */
export function seedResumeFixture(runtime: InitiativeRecordRuntime): SeedResumeFixtureResult {
  let seq = 0;
  function call<T>(operation: string, input: Record<string, unknown>): T {
    const provenance = provenanceAt(seq);
    seq += 1;
    return runtime.execute({ operation, input, expected_revision: 0, provenance }) as T;
  }

  const product = call<Product>('product_create', {
    name: 'Resume Fixture Product',
    slug: 'resume-fixture-product',
  });

  const workspaceOne = call<Workspace>('workspace_create', {
    product_id: product.uuid,
    name: 'Engine Workspace',
    slug: 'engine-workspace',
    description: 'The engine repo workspace.',
  });
  const workspaceTwo = call<Workspace>('workspace_create', {
    product_id: product.uuid,
    name: 'Docs Workspace',
    slug: 'docs-workspace',
    description: 'The docs workspace.',
  });

  const resourceOne = call<Resource>('resource_register', {
    workspace_id: workspaceOne.uuid,
    type: 'repo',
    canonical_locator: 'resume-fixture-r1',
    description: 'First engine resource.',
  });
  const resourceTwo = call<Resource>('resource_register', {
    workspace_id: workspaceOne.uuid,
    type: 'repo',
    canonical_locator: 'resume-fixture-r2',
    description: 'Second engine resource.',
  });
  const resourceThree = call<Resource>('resource_register', {
    workspace_id: workspaceTwo.uuid,
    type: 'doc',
    canonical_locator: 'resume-fixture-r3',
    description: 'Docs resource.',
  });

  const initiative = call<Initiative>('initiative_create', {
    product_id: product.uuid,
    title: 'Resume Fixture Target',
    goal: 'Prove the resume contract survives a fresh runtime.',
    status: 'open',
    outcome: null,
  });
  const relatedInitiative = call<Initiative>('initiative_create', {
    product_id: product.uuid,
    title: 'Resume Fixture Related',
    goal: 'A related Initiative the target depends on.',
    status: 'closed',
    outcome: 'delivered',
  });

  const linkOne = call<InitiativeWorkspaceLink>('initiative_link_workspace', {
    initiative_id: initiative.uuid,
    workspace_id: workspaceOne.uuid,
    role: 'consumes',
  });
  const linkTwo = call<InitiativeWorkspaceLink>('initiative_link_workspace', {
    initiative_id: initiative.uuid,
    workspace_id: workspaceTwo.uuid,
    role: 'references',
  });

  const relation = call<InitiativeRelation>('initiative_relate', {
    from_id: initiative.uuid,
    to_id: relatedInitiative.uuid,
    type: 'depends_on',
  });

  const taskOpen = call<Task>('initiative_task_create', {
    initiative_id: initiative.uuid,
    title: 'Non-terminal task',
    goal: 'Represent in-flight work.',
    status: 'in_progress',
    outcome: null,
    workspace_ids: [workspaceOne.uuid],
    resource_ids: [resourceOne.uuid],
  });
  const taskDone = call<Task>('initiative_task_create', {
    initiative_id: initiative.uuid,
    title: 'Terminal task',
    goal: 'Represent completed work.',
    status: 'completed',
    outcome: 'succeeded',
    workspace_ids: [],
    resource_ids: [],
  });

  const artifactOne = call<ArtifactRef>('artifact_register', {
    initiative_id: initiative.uuid,
    storage_mode: 'external',
    path_or_uri: 'https://example.com/resume-fixture/a1',
    description: 'First external artifact.',
    produced_by_task: taskDone.uuid,
  });
  const artifactTwo = call<ArtifactRef>('artifact_register', {
    initiative_id: initiative.uuid,
    storage_mode: 'external',
    path_or_uri: 'https://example.com/resume-fixture/a2',
    description: 'Second external artifact.',
  });

  // Phase A1 — professional record and verification ledger (Task I-8,
  // SPEC-002). Exercises every resume ordering rule: Requirements/Acceptance
  // Criteria creation order; Decision status-group order (`open`, `decided`,
  // `superseded`) via a real `decision_supersede`; Risk resume order (open
  // first, severity high to low, then other statuses); Evidence creation
  // order; and `verification`'s latest-run selection plus automatic
  // superseding of a prior non-terminal run.
  const requirementOne = call<Requirement>('requirement_add', {
    initiative_id: initiative.uuid,
    statement: 'The engine must persist Requirements.',
  });
  const requirementTwo = call<Requirement>('requirement_add', {
    initiative_id: initiative.uuid,
    statement: 'The engine must persist Acceptance Criteria.',
  });

  const criterionOneA = call<AcceptanceCriterion>('acceptance_criterion_add', {
    requirement_id: requirementOne.uuid,
    statement: 'Requirement rows survive a reopen.',
    check_reference: 'a1-resume-golden.check.test.ts',
  });
  const criterionOneB = call<AcceptanceCriterion>('acceptance_criterion_add', {
    requirement_id: requirementOne.uuid,
    statement: 'Requirement ordering is createdAt then uuid.',
    check_reference: 'a1-resume-golden.check.test.ts',
  });
  const criterionTwoA = call<AcceptanceCriterion>('acceptance_criterion_add', {
    requirement_id: requirementTwo.uuid,
    statement: 'Acceptance Criteria are scoped to their Requirement.',
    check_reference: 'a1-resume-golden.check.test.ts',
  });

  const decisionOpen = call<Decision>('decision_record', {
    initiative_id: initiative.uuid,
    title: 'Keep the resume payload additive',
    decision: 'Add fields, never remove Phase A0 fields.',
    rationale: 'Existing callers must not break.',
    alternatives: ['Ship a v2 endpoint'],
    status: 'open',
  });
  const decisionDecided = call<Decision>('decision_record', {
    initiative_id: initiative.uuid,
    title: 'Store Decision.alternatives as JSON',
    decision: 'Use a JSON column.',
    rationale: 'The public contract only requires string[] behavior.',
    alternatives: ['A join table'],
    status: 'decided',
  });
  const decisionToSupersede = call<Decision>('decision_record', {
    initiative_id: initiative.uuid,
    title: 'Draft verification method list',
    decision: 'Start with just command.',
    rationale: 'Smallest surface first.',
    alternatives: [],
    status: 'open',
  });
  const decisionSuperseding = call<Decision>('decision_supersede', {
    uuid: decisionToSupersede.uuid,
    title: 'Widen verification method list',
    decision: 'Support command, agent-review, and human.',
    rationale: 'Not every check is scriptable.',
    alternatives: ['Keep just command'],
  });
  const decisionSuperseded: Decision = {
    ...decisionToSupersede,
    status: 'superseded',
    superseded_by: decisionSuperseding.uuid,
    updatedAt: decisionSuperseding.createdAt,
    revision: decisionToSupersede.revision + 1,
  };

  const riskHighOpen = call<Risk>('risk_add', {
    initiative_id: initiative.uuid,
    statement: 'Resume payload growth could break large installs.',
    severity: 'high',
    status: 'open',
  });
  const riskLowOpen = call<Risk>('risk_add', {
    initiative_id: initiative.uuid,
    statement: 'Fixture drift between spec and golden.',
    severity: 'low',
    status: 'open',
  });
  const riskMediumClosed = call<Risk>('risk_add', {
    initiative_id: initiative.uuid,
    statement: 'Migration backup verification could stall a release.',
    severity: 'medium',
    status: 'closed',
  });

  const evidenceOne = call<Evidence>('evidence_add', {
    initiative_id: initiative.uuid,
    kind: 'test-run',
    locator: 'tests/initiative-record/a1-resume-golden.check.test.ts',
    content_hash: null,
    summary: 'The golden resume check passes.',
  });
  const evidenceTwo = call<Evidence>('evidence_add', {
    initiative_id: initiative.uuid,
    kind: 'build-log',
    locator: 'pnpm run build',
    content_hash: 'sha256:deadbeef',
    summary: 'The full build passes.',
  });

  const verificationOnePending = call<VerificationRun>('verification_record', {
    initiative_id: initiative.uuid,
    acceptance_criterion_id: criterionOneA.uuid,
    method: 'command',
    state: 'pending',
    detail: 'Golden check queued.',
  });
  const verificationOnePass = call<VerificationRun>('verification_record', {
    initiative_id: initiative.uuid,
    acceptance_criterion_id: criterionOneA.uuid,
    method: 'command',
    state: 'pass',
    detail: 'Golden check passed.',
  });
  const verificationTwoFail = call<VerificationRun>('verification_record', {
    initiative_id: initiative.uuid,
    acceptance_criterion_id: criterionOneB.uuid,
    method: 'agent-review',
    state: 'fail',
    detail: 'Ordering rule not yet implemented.',
  });

  // The installation-wide Event log: exactly one Event per mutating call
  // above, in creation order. `initiativeResume` (Task I-5) returns the
  // *unscoped* installation Event log newest-first — see that method's
  // `[...allEvents].reverse().slice(0, eventLimit)`, not a per-Initiative
  // filter — so this fixture's expected `events` covers every seeded Event,
  // not only Events carrying this Initiative's `initiative_id`.
  const eventsAscending: Event[] = [
    {
      event_sequence: 1,
      entity_type: 'Product',
      entity_id: product.uuid,
      initiative_id: null,
      event_type: 'product_created',
      payload: { uuid: product.uuid, slug: product.slug },
      ...provenanceAt(0),
    },
    {
      event_sequence: 2,
      entity_type: 'Workspace',
      entity_id: workspaceOne.uuid,
      initiative_id: null,
      event_type: 'workspace_created',
      payload: { uuid: workspaceOne.uuid, product_id: product.uuid, slug: workspaceOne.slug },
      ...provenanceAt(1),
    },
    {
      event_sequence: 3,
      entity_type: 'Workspace',
      entity_id: workspaceTwo.uuid,
      initiative_id: null,
      event_type: 'workspace_created',
      payload: { uuid: workspaceTwo.uuid, product_id: product.uuid, slug: workspaceTwo.slug },
      ...provenanceAt(2),
    },
    {
      event_sequence: 4,
      entity_type: 'Resource',
      entity_id: resourceOne.uuid,
      initiative_id: null,
      event_type: 'resource_registered',
      payload: { uuid: resourceOne.uuid, workspace_id: workspaceOne.uuid, canonical_locator: resourceOne.canonical_locator },
      ...provenanceAt(3),
    },
    {
      event_sequence: 5,
      entity_type: 'Resource',
      entity_id: resourceTwo.uuid,
      initiative_id: null,
      event_type: 'resource_registered',
      payload: { uuid: resourceTwo.uuid, workspace_id: workspaceOne.uuid, canonical_locator: resourceTwo.canonical_locator },
      ...provenanceAt(4),
    },
    {
      event_sequence: 6,
      entity_type: 'Resource',
      entity_id: resourceThree.uuid,
      initiative_id: null,
      event_type: 'resource_registered',
      payload: { uuid: resourceThree.uuid, workspace_id: workspaceTwo.uuid, canonical_locator: resourceThree.canonical_locator },
      ...provenanceAt(5),
    },
    {
      event_sequence: 7,
      entity_type: 'Initiative',
      entity_id: initiative.uuid,
      initiative_id: initiative.uuid,
      event_type: 'initiative_created',
      payload: { uuid: initiative.uuid, human_key: initiative.human_key, product_id: product.uuid },
      ...provenanceAt(6),
    },
    {
      event_sequence: 8,
      entity_type: 'Initiative',
      entity_id: relatedInitiative.uuid,
      initiative_id: relatedInitiative.uuid,
      event_type: 'initiative_created',
      payload: { uuid: relatedInitiative.uuid, human_key: relatedInitiative.human_key, product_id: product.uuid },
      ...provenanceAt(7),
    },
    {
      event_sequence: 9,
      entity_type: 'InitiativeWorkspaceLink',
      entity_id: `${initiative.uuid}:${workspaceOne.uuid}:consumes`,
      initiative_id: initiative.uuid,
      event_type: 'initiative_workspace_linked',
      payload: { initiative_id: initiative.uuid, workspace_id: workspaceOne.uuid, role: 'consumes' },
      ...provenanceAt(8),
    },
    {
      event_sequence: 10,
      entity_type: 'InitiativeWorkspaceLink',
      entity_id: `${initiative.uuid}:${workspaceTwo.uuid}:references`,
      initiative_id: initiative.uuid,
      event_type: 'initiative_workspace_linked',
      payload: { initiative_id: initiative.uuid, workspace_id: workspaceTwo.uuid, role: 'references' },
      ...provenanceAt(9),
    },
    {
      event_sequence: 11,
      entity_type: 'InitiativeRelation',
      entity_id: `${initiative.uuid}:${relatedInitiative.uuid}:depends_on`,
      initiative_id: initiative.uuid,
      event_type: 'initiative_related',
      payload: { from_id: initiative.uuid, to_id: relatedInitiative.uuid, type: 'depends_on' },
      ...provenanceAt(10),
    },
    {
      event_sequence: 12,
      entity_type: 'Task',
      entity_id: taskOpen.uuid,
      initiative_id: initiative.uuid,
      event_type: 'task_created',
      payload: { uuid: taskOpen.uuid, initiative_id: initiative.uuid, status: 'in_progress' },
      ...provenanceAt(11),
    },
    {
      event_sequence: 13,
      entity_type: 'Task',
      entity_id: taskDone.uuid,
      initiative_id: initiative.uuid,
      event_type: 'task_created',
      payload: { uuid: taskDone.uuid, initiative_id: initiative.uuid, status: 'completed' },
      ...provenanceAt(12),
    },
    {
      event_sequence: 14,
      entity_type: 'ArtifactRef',
      entity_id: artifactOne.uuid,
      initiative_id: initiative.uuid,
      event_type: 'artifact_registered',
      payload: {
        uuid: artifactOne.uuid,
        initiative_id: initiative.uuid,
        path_or_uri: artifactOne.path_or_uri,
        storage_mode: artifactOne.storage_mode,
      },
      ...provenanceAt(13),
    },
    {
      event_sequence: 15,
      entity_type: 'ArtifactRef',
      entity_id: artifactTwo.uuid,
      initiative_id: initiative.uuid,
      event_type: 'artifact_registered',
      payload: {
        uuid: artifactTwo.uuid,
        initiative_id: initiative.uuid,
        path_or_uri: artifactTwo.path_or_uri,
        storage_mode: artifactTwo.storage_mode,
      },
      ...provenanceAt(14),
    },
    // Phase A1 Events (Task I-8): one per mutating call above from
    // `requirementOne` through `verificationTwoFail`, including the two
    // Events each written by `decision_supersede` and by the
    // superseding `verification_record` call.
    {
      event_sequence: 16,
      entity_type: 'Requirement',
      entity_id: requirementOne.uuid,
      initiative_id: initiative.uuid,
      event_type: 'requirement_added',
      payload: { uuid: requirementOne.uuid, initiative_id: initiative.uuid, human_key: requirementOne.human_key },
      ...provenanceAt(15),
    },
    {
      event_sequence: 17,
      entity_type: 'Requirement',
      entity_id: requirementTwo.uuid,
      initiative_id: initiative.uuid,
      event_type: 'requirement_added',
      payload: { uuid: requirementTwo.uuid, initiative_id: initiative.uuid, human_key: requirementTwo.human_key },
      ...provenanceAt(16),
    },
    {
      event_sequence: 18,
      entity_type: 'AcceptanceCriterion',
      entity_id: criterionOneA.uuid,
      initiative_id: initiative.uuid,
      event_type: 'acceptance_criterion_added',
      payload: { uuid: criterionOneA.uuid, requirement_id: requirementOne.uuid, human_key: criterionOneA.human_key },
      ...provenanceAt(17),
    },
    {
      event_sequence: 19,
      entity_type: 'AcceptanceCriterion',
      entity_id: criterionOneB.uuid,
      initiative_id: initiative.uuid,
      event_type: 'acceptance_criterion_added',
      payload: { uuid: criterionOneB.uuid, requirement_id: requirementOne.uuid, human_key: criterionOneB.human_key },
      ...provenanceAt(18),
    },
    {
      event_sequence: 20,
      entity_type: 'AcceptanceCriterion',
      entity_id: criterionTwoA.uuid,
      initiative_id: initiative.uuid,
      event_type: 'acceptance_criterion_added',
      payload: { uuid: criterionTwoA.uuid, requirement_id: requirementTwo.uuid, human_key: criterionTwoA.human_key },
      ...provenanceAt(19),
    },
    {
      event_sequence: 21,
      entity_type: 'Decision',
      entity_id: decisionOpen.uuid,
      initiative_id: initiative.uuid,
      event_type: 'decision_recorded',
      payload: { uuid: decisionOpen.uuid, initiative_id: initiative.uuid, human_key: decisionOpen.human_key, status: 'open' },
      ...provenanceAt(20),
    },
    {
      event_sequence: 22,
      entity_type: 'Decision',
      entity_id: decisionDecided.uuid,
      initiative_id: initiative.uuid,
      event_type: 'decision_recorded',
      payload: { uuid: decisionDecided.uuid, initiative_id: initiative.uuid, human_key: decisionDecided.human_key, status: 'decided' },
      ...provenanceAt(21),
    },
    {
      event_sequence: 23,
      entity_type: 'Decision',
      entity_id: decisionToSupersede.uuid,
      initiative_id: initiative.uuid,
      event_type: 'decision_recorded',
      payload: { uuid: decisionToSupersede.uuid, initiative_id: initiative.uuid, human_key: decisionToSupersede.human_key, status: 'open' },
      ...provenanceAt(22),
    },
    {
      event_sequence: 24,
      entity_type: 'Decision',
      entity_id: decisionSuperseding.uuid,
      initiative_id: initiative.uuid,
      event_type: 'decision_recorded',
      payload: { uuid: decisionSuperseding.uuid, initiative_id: initiative.uuid, human_key: decisionSuperseding.human_key, status: 'decided' },
      ...provenanceAt(23),
    },
    {
      event_sequence: 25,
      entity_type: 'Decision',
      entity_id: decisionToSupersede.uuid,
      initiative_id: initiative.uuid,
      event_type: 'decision_superseded',
      payload: { uuid: decisionToSupersede.uuid, superseded_by: decisionSuperseding.uuid },
      ...provenanceAt(23),
    },
    {
      event_sequence: 26,
      entity_type: 'Risk',
      entity_id: riskHighOpen.uuid,
      initiative_id: initiative.uuid,
      event_type: 'risk_added',
      payload: { uuid: riskHighOpen.uuid, initiative_id: initiative.uuid, human_key: riskHighOpen.human_key, severity: 'high', status: 'open' },
      ...provenanceAt(24),
    },
    {
      event_sequence: 27,
      entity_type: 'Risk',
      entity_id: riskLowOpen.uuid,
      initiative_id: initiative.uuid,
      event_type: 'risk_added',
      payload: { uuid: riskLowOpen.uuid, initiative_id: initiative.uuid, human_key: riskLowOpen.human_key, severity: 'low', status: 'open' },
      ...provenanceAt(25),
    },
    {
      event_sequence: 28,
      entity_type: 'Risk',
      entity_id: riskMediumClosed.uuid,
      initiative_id: initiative.uuid,
      event_type: 'risk_added',
      payload: { uuid: riskMediumClosed.uuid, initiative_id: initiative.uuid, human_key: riskMediumClosed.human_key, severity: 'medium', status: 'closed' },
      ...provenanceAt(26),
    },
    {
      event_sequence: 29,
      entity_type: 'Evidence',
      entity_id: evidenceOne.uuid,
      initiative_id: initiative.uuid,
      event_type: 'evidence_added',
      payload: { uuid: evidenceOne.uuid, initiative_id: initiative.uuid, locator: evidenceOne.locator },
      ...provenanceAt(27),
    },
    {
      event_sequence: 30,
      entity_type: 'Evidence',
      entity_id: evidenceTwo.uuid,
      initiative_id: initiative.uuid,
      event_type: 'evidence_added',
      payload: { uuid: evidenceTwo.uuid, initiative_id: initiative.uuid, locator: evidenceTwo.locator },
      ...provenanceAt(28),
    },
    {
      event_sequence: 31,
      entity_type: 'VerificationRun',
      entity_id: verificationOnePending.uuid,
      initiative_id: initiative.uuid,
      event_type: 'verification_recorded',
      payload: {
        uuid: verificationOnePending.uuid,
        initiative_id: initiative.uuid,
        acceptance_criterion_id: criterionOneA.uuid,
        method: 'command',
        state: 'pending',
      },
      ...provenanceAt(29),
    },
    {
      event_sequence: 32,
      entity_type: 'VerificationRun',
      entity_id: verificationOnePass.uuid,
      initiative_id: initiative.uuid,
      event_type: 'verification_recorded',
      payload: {
        uuid: verificationOnePass.uuid,
        initiative_id: initiative.uuid,
        acceptance_criterion_id: criterionOneA.uuid,
        method: 'command',
        state: 'pass',
      },
      ...provenanceAt(30),
    },
    {
      event_sequence: 33,
      entity_type: 'VerificationRun',
      entity_id: verificationOnePending.uuid,
      initiative_id: initiative.uuid,
      event_type: 'verification_superseded',
      payload: { uuid: verificationOnePending.uuid, acceptance_criterion_id: criterionOneA.uuid },
      ...provenanceAt(30),
    },
    {
      event_sequence: 34,
      entity_type: 'VerificationRun',
      entity_id: verificationTwoFail.uuid,
      initiative_id: initiative.uuid,
      event_type: 'verification_recorded',
      payload: {
        uuid: verificationTwoFail.uuid,
        initiative_id: initiative.uuid,
        acceptance_criterion_id: criterionOneB.uuid,
        method: 'agent-review',
        state: 'fail',
      },
      ...provenanceAt(31),
    },
  ];
  const events = [...eventsAscending].reverse();

  // SPEC-004 Lifecycle Engine (Task I-4): this fixture performs NO phase or focus
  // mutations, so every Phase Record synthesizes to `not_started` and the built-in
  // `default-sdl@1` contract (the `initiative_create` default) evaluates each
  // Establishment against the Phase A1 data seeded above — `requirements_exist` and
  // `acceptance_criteria_exist` read satisfied (Requirements/Acceptance Criteria were
  // seeded), `decisions_settled` reads unsatisfied (`decisionOpen` remains `'open'`),
  // and every `manual` Establishment reads unsatisfied (no `initiative_phase_satisfy`
  // call was ever made).
  const expectedLifecycle: LifecycleResumeBlock = {
    focus_phase: null,
    contract: 'default-sdl@1',
    phases: [
      {
        phase: 'discover',
        state: 'not_started',
        gate: {
          status: 'red',
          missing: [
            {
              establishment: { key: 'problem_framed', satisfier: 'manual' },
              satisfied: false,
              detail: "Manual establishment 'problem_framed' has not been asserted for this phase and contract.",
            },
          ],
        },
      },
      {
        phase: 'refine',
        state: 'not_started',
        gate: {
          status: 'red',
          missing: [
            {
              establishment: { key: 'scoped_goal', satisfier: 'manual' },
              satisfied: false,
              detail: "Manual establishment 'scoped_goal' has not been asserted for this phase and contract.",
            },
          ],
        },
      },
      {
        phase: 'design',
        state: 'not_started',
        gate: {
          status: 'red',
          missing: [
            {
              establishment: { key: 'design_artifact', satisfier: 'manual' },
              satisfied: false,
              detail: "Manual establishment 'design_artifact' has not been asserted for this phase and contract.",
            },
            {
              establishment: { key: 'key_decisions_settled', satisfier: 'decisions_settled' },
              satisfied: false,
              detail: "Every recorded Decision must reach a non-'open' status (establishment 'key_decisions_settled').",
            },
          ],
        },
      },
      { phase: 'execute', state: 'not_started', gate: { status: 'green', missing: [] } },
      {
        phase: 'verify',
        state: 'not_started',
        gate: {
          status: 'red',
          missing: [
            {
              establishment: { key: 'acceptance_verified', satisfier: 'manual' },
              satisfied: false,
              detail: "Manual establishment 'acceptance_verified' has not been asserted for this phase and contract.",
            },
          ],
        },
      },
      {
        phase: 'deliver',
        state: 'not_started',
        gate: {
          status: 'red',
          missing: [
            {
              establishment: { key: 'delivery_confirmed', satisfier: 'manual' },
              satisfied: false,
              detail: "Manual establishment 'delivery_confirmed' has not been asserted for this phase and contract.",
            },
          ],
        },
      },
    ],
    recent_lifecycle_events: [],
  };

  const expectedResume: InitiativeResumeResponse = {
    initiative,
    product,
    workspaces: [
      { role: 'consumes', workspace: workspaceOne, resources: [resourceOne, resourceTwo] },
      { role: 'references', workspace: workspaceTwo, resources: [resourceThree] },
    ],
    related_initiatives: [{ relation, initiative: relatedInitiative }],
    tasks: [taskOpen, taskDone],
    artifacts: [artifactOne, artifactTwo],
    events,
    requirements: [
      { requirement: requirementOne, acceptance_criteria: [criterionOneA, criterionOneB] },
      { requirement: requirementTwo, acceptance_criteria: [criterionTwoA] },
    ],
    decisions: [decisionOpen, decisionDecided, decisionSuperseding, decisionSuperseded],
    risks: [riskHighOpen, riskLowOpen, riskMediumClosed],
    evidence: [evidenceOne, evidenceTwo],
    verification: [
      { acceptance_criterion_id: criterionOneA.uuid, latest: verificationOnePass },
      { acceptance_criterion_id: criterionOneB.uuid, latest: verificationTwoFail },
    ],
    lifecycle: expectedLifecycle,
    // MMA Next gap-closure (§15): this fixture defines no Deliverables, so the additive
    // `deliverables` resume section and its count both read empty/zero.
    deliverables: [],
    counts: {
      workspaces: 2,
      resources: 3,
      related_initiatives: 1,
      tasks: 2,
      tasks_by_status: { open: 0, claimed: 0, in_progress: 1, blocked: 0, completed: 1, cancelled: 0 },
      artifacts: 2,
      events_returned: events.length,
      events_total: events.length,
      requirements: 2,
      acceptance_criteria: 3,
      decisions_open: 1,
      risks_open: 2,
      evidence: 2,
      verification_by_state: {
        pending: 0,
        pass: 1,
        fail: 1,
        blocked: 0,
        needs_human_review: 0,
        stale: 0,
        not_applicable: 0,
        superseded: 1,
      },
      deliverables_by_validation_state: { pending: 0, valid: 0, invalid: 0, human_approved: 0 },
    },
  };

  return {
    product,
    workspaces: [workspaceOne, workspaceTwo],
    resources: [resourceOne, resourceTwo, resourceThree],
    initiative,
    relatedInitiative,
    links: [linkOne, linkTwo],
    relation,
    tasks: [taskOpen, taskDone],
    artifacts: [artifactOne, artifactTwo],
    requirements: [requirementOne, requirementTwo],
    criteria: [criterionOneA, criterionOneB, criterionTwoA],
    decisions: [decisionOpen, decisionDecided, decisionSuperseding],
    risks: [riskHighOpen, riskLowOpen, riskMediumClosed],
    evidence: [evidenceOne, evidenceTwo],
    verificationRuns: [verificationOnePending, verificationOnePass, verificationTwoFail],
    events,
    expectedResume,
  };
}
