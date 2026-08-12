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
  ArtifactRef,
  Event,
  Initiative,
  InitiativeRelation,
  InitiativeResumeResponse,
  InitiativeWorkspaceLink,
  Product,
  Resource,
  Task,
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
  ];
  const events = [...eventsAscending].reverse();

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
    counts: {
      workspaces: 2,
      resources: 3,
      related_initiatives: 1,
      tasks: 2,
      tasks_by_status: { open: 0, claimed: 0, in_progress: 1, blocked: 0, completed: 1, cancelled: 0 },
      artifacts: 2,
      events_returned: events.length,
      events_total: events.length,
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
    events,
    expectedResume,
  };
}
