/**
 * Live coverage of the Initiative Record surface — the half of the product the numeric SCENARIOS
 * array never touched. Those scenarios exercise the EXECUTION routes (spec / plan / review /
 * execute_plan …). Everything the MMA Next grand plan promises about the RECORD — resume, the
 * lifecycle engine, methods, business intake, and the delivery layer — had zero live coverage
 * until this module, which is how a set of public-contract defects survived to manual testing.
 *
 * Each entry maps to a declared acceptance criterion so a reader can trace a failure back to the
 * promise it breaks (grand plan §15 application surface, §21 success criteria).
 *
 * Scope: BACKEND ONLY. No Forge, no renderers/HTML, no tunnel, and no real target adapter — the
 * adapter seam is proven capable by a fake, which is what "zero target logic in core" means here.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMOKE_CLIENT } from './http.mjs';

const BASE = 'http://127.0.0.1:7337';

/** One directory per registered Method, each holding a committed `guidance.md`. */
const METHOD_ASSET_COUNT = readdirSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core', 'src', 'methods'),
  { withFileTypes: true },
).filter((e) => e.isDirectory()).length;

const provenance = {
  actor_type: 'agent', actor_id: 'full-smoke', initiated_by: 'smoke-harness',
  authorized_by: 'smoke-harness', source: 'full-smoke',
};

async function op(token, cwd, operation, input, extra = {}) {
  const res = await fetch(`${BASE}/initiatives?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MMA-Client': SMOKE_CLIENT, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, input, ...extra }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body stays null */ }
  return { status: res.status, json };
}
const mut = (token, cwd, operation, input, revision, extra = {}) =>
  op(token, cwd, operation, input, { expected_revision: revision, provenance, ...extra });

const C = (checkId, ok, detail) => ({ checkId, status: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 300) });

/**
 * Runs the record-surface suite. Returns `{ records, checksByScenario }` in the exact shape the
 * harness report expects, so these land in the same table as every execution scenario.
 */
export async function runRecordSurface(ctx, log) {
  const token = ctx.token;
  // The harness `ctx` carries no cwd (see preflight.mjs) — the smoke always runs from the
  // engine repo root, and every record operation is cwd-scoped, so resolve it explicitly
  // rather than letting `undefined` reach the query string.
  const cwd = ctx.cwd ?? process.cwd();
  const records = [];
  const checksByScenario = {};
  const add = (scenarioId, type, checks) => {
    records.push({ scenarioId, type, expect: { kind: 'record' } });
    checksByScenario[scenarioId] = checks;
    const bad = checks.filter((c) => c.status === 'FAIL').length;
    log(`#${scenarioId}  ${type}  → ${checks.length - bad}/${checks.length} checks`);
  };

  const suffix = `${Date.now()}`;
  let initiative = null, deliverable = null, workspaceId = null, productId = null;

  // ── R1 (AC C1/C2) greenfield intake: one atomic call, and an all-or-nothing failure ─────────
  {
    const checks = [];
    const created = await mut(token, cwd, 'initiative_bootstrap', {
      product: { create: { name: 'Smoke Product', slug: `smoke-${suffix}` } },
      workspaces: [
        { workspace_key: 'primary', role: 'creates', create: { name: 'Greenfield', slug: `greenfield-${suffix}`, description: 'A workspace whose repository does not exist yet.' } },
        { workspace_key: 'second', role: 'references', create: { name: 'Reference', slug: `reference-${suffix}`, description: 'A second workspace, proving one Initiative spans several.' } },
      ],
      resources: [],
      initiative: { title: 'Smoke Initiative', goal: 'Prove the promised record surface end to end.', status: 'open', outcome: null },
      requirements: [{ statement: 'The record must survive the full smoke.' }],
    }, 0);
    checks.push(C('bootstrap-atomic', created.status === 200, `status=${created.status} ${created.status === 200 ? '' : JSON.stringify(created.json).slice(0, 160)}`));
    if (created.status === 200) {
      initiative = created.json.uuid;
      // `resource_list` is workspace-scoped, so the read-surface section below needs a real
      // workspace id — without one it 400s on a missing field, which would look like a broken
      // operation rather than a malformed call.
      workspaceId = (created.json.workspaces ?? [])[0]?.uuid ?? null;
      productId = created.json.product?.uuid ?? (created.json.workspaces ?? [])[0]?.product_id ?? null;
      // Record it for teardown to REPORT. It cannot be removed: the Initiative Record API has 26
      // operations and none of them deletes, so every smoke run leaves this row behind in the
      // daemon's real initiatives.db. Teardown says so rather than letting it accumulate silently.
      (ctx.createdInitiatives ??= []).push(initiative);
      checks.push(C('multi-workspace', (created.json.workspaces || []).length === 2, `workspaces=${(created.json.workspaces || []).length}`));
      // This was a hardcoded `true` — it asserted nothing and would have passed even if the
      // daemon had silently substituted a repository-backed workspace. Assert the actual shape:
      // the creates-role workspace came back, and it carries no Resource, no local path and no
      // remote, which is what "greenfield" means here.
      const greenfield = (created.json.workspaces || []).find((w) => w.slug === `greenfield-${suffix}`);
      const greenfieldResources = (created.json.resources || []).filter((r) => r.workspace_id === greenfield?.uuid);
      checks.push(C('greenfield-no-git',
        !!greenfield && greenfieldResources.length === 0 && !greenfield.local_path && !greenfield.canonical_locator,
        `workspace=${greenfield ? 'created' : 'MISSING'} resources=${greenfieldResources.length} local_path=${greenfield?.local_path ?? 'none'}`));
      checks.push(C('default-contract', created.json.lifecycle_contract === 'default-sdl@1', `contract=${created.json.lifecycle_contract}`));
    }
    const before = (await op(token, cwd, 'initiative_list', {})).json?.length ?? -1;
    const doomed = await mut(token, cwd, 'initiative_bootstrap', {
      product: { create: { name: 'Doomed', slug: `doomed-${suffix}` } },
      workspaces: [
        { workspace_key: 'a', role: 'creates', create: { name: 'A', slug: `dup-${suffix}`, description: 'first' } },
        { workspace_key: 'b', role: 'creates', create: { name: 'B', slug: `dup-${suffix}`, description: 'duplicate slug must fail the whole request' } },
      ],
      resources: [],
      initiative: { title: 'Doomed', goal: 'Must never exist.', status: 'open', outcome: null },
    }, 0);
    const after = (await op(token, cwd, 'initiative_list', {})).json?.length ?? -2;
    checks.push(C('bootstrap-all-or-nothing', doomed.status >= 400 && before === after, `status=${doomed.status} initiatives ${before}->${after}`));
    add(100, 'record_intake', checks);
  }

  if (!initiative) {
    add(101, 'record_aborted', [C('prerequisite', false, 'bootstrap failed; remaining record checks skipped')]);
    return { records, checksByScenario };
  }

  const revision = async () => (await op(token, cwd, 'initiative_get', { uuid: initiative })).json.revision;

  // ── R2 (AC B1/B2/B3) lifecycle: queryable gates, red-gate override, non-enforcement ─────────
  {
    const checks = [];
    const gate = await op(token, cwd, 'initiative_gate_status', { initiative: { uuid: initiative } });
    const phases = gate.json?.phases || [];
    checks.push(C('six-phases-gated', phases.length === 6 && phases.every((p) => p.gate?.status), `phases=${phases.length}`));
    const refineBefore = phases.find((p) => p.phase === 'refine');
    const enter = await mut(token, cwd, 'initiative_phase_enter', { initiative: { uuid: initiative }, phase: 'refine' }, await revision());
    checks.push(C('phase-mutation-returns-revision', typeof enter.json?.revision === 'number',
      `revision=${enter.json?.revision} — a caller must be able to chain transitions without a re-read`));
    // Satisfy while the gate is RED: the engine records and advises, it never vetoes.
    const satisfy = await mut(token, cwd, 'initiative_phase_satisfy', { initiative: { uuid: initiative }, phase: 'refine' }, enter.json?.revision ?? await revision());
    checks.push(C('red-gate-not-vetoed', satisfy.status === 200, `refine gate was ${refineBefore?.gate?.status}; satisfy status=${satisfy.status}`));
    const resumed = await op(token, cwd, 'initiative_resume', { initiative: { uuid: initiative } });
    const satisfiedEvent = (resumed.json?.events || []).find((e) => e.event_type === 'phase_satisfied');
    checks.push(C('red-gate-snapshot-recorded', !!satisfiedEvent?.payload?.gate_snapshot,
      `snapshot=${satisfiedEvent?.payload?.gate_snapshot?.status ?? 'ABSENT'}`));
    add(101, 'record_lifecycle', checks);
  }

  // ── R3 (AC A1/A2/H3) resume completeness, deliverable visibility, provenance ────────────────
  {
    const checks = [];
    const r = await op(token, cwd, 'initiative_resume', { initiative: { uuid: initiative } });
    const want = ['initiative', 'product', 'workspaces', 'related_initiatives', 'tasks', 'artifacts', 'events',
      'requirements', 'decisions', 'risks', 'evidence', 'verification', 'lifecycle', 'counts', 'deliverables'];
    const missing = want.filter((k) => !Object.prototype.hasOwnProperty.call(r.json || {}, k));
    checks.push(C('resume-complete', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : `all ${want.length} sections present`));
    checks.push(C('resume-canonical-envelope', r.status === 200, `input-wrapped envelope status=${r.status}`));
    const legacy = await fetch(`${BASE}/initiatives?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MMA-Client': SMOKE_CLIENT, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative } }),
    });
    checks.push(C('resume-rejects-legacy-shape', legacy.status >= 400,
      `top-level initiative status=${legacy.status} — the two dedicated reads must share one envelope`));
    const events = r.json?.events || [];
    const unprovenanced = events.filter((e) => !e.actor_id || !e.interface || !e.authorized_by);
    checks.push(C('event-provenance', events.length > 0 && unprovenanced.length === 0,
      `${events.length} events, ${unprovenanced.length} missing who/through-what/authorized-by`));
    add(102, 'record_resume', checks);
  }

  // ── R4 (AC E1) methods: registered, immutable, unknown rejected ─────────────────────────────
  {
    const checks = [];
    const list = await op(token, cwd, 'method_list', {});
    const ids = (list.json || []).map((m) => m.id);
    // Counted from the committed guidance assets, which `assertGuidanceAssetBijection` already
    // holds in exact correspondence with the registry — not the literal 10 this carried, which
    // would fail on the eleventh Method for being right.
    checks.push(C('methods-registered', ids.length === METHOD_ASSET_COUNT,
      `methods=${ids.length} want=${METHOD_ASSET_COUNT} (one per committed guidance asset)`));
    checks.push(C('intent-to-initiative-seeded', ids.includes('intent-to-initiative@1'), ids.includes('intent-to-initiative@1') ? 'present' : `absent from ${ids.join(',')}`));
    const register = await mut(token, cwd, 'method_register', { id: 'evil@1' }, 0);
    checks.push(C('methods-immutable', register.status >= 400, `register attempt status=${register.status}`));
    add(103, 'record_methods', checks);
  }

  // ── R5 (AC G1/G3/G4) delivery: computed validation, non-enforcement, packaging ──────────────
  {
    const checks = [];
    const contracts = await op(token, cwd, 'delivery_contract_list', {});
    const contractIds = (contracts.json || []).map((c) => c.id).sort();
    checks.push(C('delivery-contracts-seeded', contractIds.length === 2, `contracts=${contractIds.join(',')}`));
    const defined = await mut(token, cwd, 'deliverable_define',
      { initiative_id: initiative, target_type: 'runnable-software', delivery_contract: 'runnable-software@1' }, 0);
    checks.push(C('deliverable-define', defined.status === 200, `status=${defined.status} ${defined.status === 200 ? '' : JSON.stringify(defined.json).slice(0, 150)}`));
    if (defined.status === 200) {
      deliverable = defined.json.uuid;
      const validated = await mut(token, cwd, 'deliverable_validate', { deliverable_id: deliverable }, defined.json.revision);
      checks.push(C('validation-computed', validated.json?.validation_state === 'invalid',
        `state=${validated.json?.validation_state} detail=${validated.json?.validation_detail} (empty membership must compute invalid, never caller-set)`));
      const current = (await op(token, cwd, 'deliverable_get', { uuid: deliverable })).json.revision;
      const delivered = await mut(token, cwd, 'deliverable_deliver', { deliverable_id: deliverable, delivery_reference: 'smoke-handoff' }, current);
      const after = (await op(token, cwd, 'deliverable_get', { uuid: deliverable })).json;
      checks.push(C('invalid-delivery-not-vetoed', delivered.status === 200 && after.validation_state === 'invalid',
        `deliver=${delivered.status} state stays ${after.validation_state} ref=${after.delivery_reference}`));
      const packaged = await mut(token, cwd, 'deliverable_package', { deliverable_id: deliverable }, after.revision);
      checks.push(C('deliverable-package', packaged.status === 200, `status=${packaged.status} ${packaged.status === 200 ? 'reports coverage gaps rather than failing' : JSON.stringify(packaged.json).slice(0, 150)}`));
    }
    add(104, 'record_delivery', checks);
  }

  // ── R6 (AC J1) export / import round trip ───────────────────────────────────────────────────
  {
    const checks = [];
    const exported = await op(token, cwd, 'initiative_export', { initiative: { uuid: initiative } });
    checks.push(C('export-portable-snapshot', exported.status === 200 && typeof exported.json?.schema_version === 'number',
      `status=${exported.status} schema_version=${exported.json?.schema_version}`));
    // Re-importing into the SAME store must be refused rather than silently merged.
    const reimport = await mut(token, cwd, 'initiative_import', { snapshot: exported.json }, 0);
    checks.push(C('import-rejects-duplicate', reimport.status >= 400,
      `re-import into the same store status=${reimport.status} — must refuse, never merge`));
    add(105, 'record_portability', checks);
  }

  // ── R8 (AC I1) verification: a command criterion can be RUN, not only recorded ─────────────
  {
    const checks = [];
    // A verification_run is CONFINED to a directory the Initiative owns, so the greenfield
    // Initiative above — which deliberately has no Resource and no local path — cannot host one.
    // Register a Workspace whose Resource declares a real local path first. That refusal is the
    // product behaving correctly, not a gap: an unconfined run would be a sandbox escape.
    const runWorkspace = await mut(token, cwd, 'workspace_create',
      { product_id: (await op(token, cwd, 'initiative_get', { uuid: initiative })).json.product_id,
        name: 'Verification host', slug: `verify-host-${suffix}`, description: 'Workspace the verification command runs inside.' }, 0);
    if (runWorkspace.status === 200) {
      await mut(token, cwd, 'resource_register',
        { workspace_id: runWorkspace.json.uuid, type: 'repository', canonical_locator: `https://example.test/${suffix}`,
          local_path: cwd, description: 'Local checkout the command runs in.' }, 0);
      await mut(token, cwd, 'initiative_link_workspace',
        { initiative_id: initiative, workspace_id: runWorkspace.json.uuid, role: 'modifies' }, 0);
    }

    // Child-entity creates carry their OWN expected_revision of 0 (the entity does not exist yet),
    // exactly like `deliverable_define` — not the parent Initiative's revision.
    const req = await mut(token, cwd, 'requirement_add', { initiative_id: initiative, statement: 'The smoke must be able to run a verification.' }, 0);
    const criterion = req.status === 200
      ? await mut(token, cwd, 'acceptance_criterion_add',
          { requirement_id: req.json.uuid, statement: 'A trivial command exits zero.', check_reference: 'true' }, 0)
      : { status: 0, json: null };
    if (criterion.status === 200) {
      const ran = await mut(token, cwd, 'verification_run', {
        initiative_id: initiative, acceptance_criterion_id: criterion.json.uuid,
        method: 'command', command: 'true',
      }, 0);
      checks.push(C('verification-run-executes', ran.status === 200, `status=${ran.status} state=${ran.json?.state ?? JSON.stringify(ran.json).slice(0, 140)}`));
      const human = await mut(token, cwd, 'verification_run', {
        initiative_id: initiative, acceptance_criterion_id: criterion.json.uuid,
        method: 'human', command: 'true',
      }, 0);
      checks.push(C('verification-run-rejects-non-machine-method', human.status >= 400,
        `human-method run status=${human.status} — only a command criterion is machine-runnable`));
    } else {
      checks.push(C('verification-run-setup', false, `could not seed a criterion: req=${req.status} ac=${criterion.status}`));
    }
    add(107, 'record_verification', checks);
  }

  // ── R7 (AC H1) concurrency: compare-and-swap, never a lost update ───────────────────────────
  {
    const checks = [];
    const stale = await mut(token, cwd, 'initiative_focus_set', { initiative: { uuid: initiative }, phase: 'execute' }, 0);
    checks.push(C('revision-conflict', stale.status === 409 && stale.json?.error?.code === 'revision_conflict',
      `status=${stale.status} code=${stale.json?.error?.code}`));
    add(106, 'record_concurrency', checks);
  }


  // ── R8 Task lifecycle: create → get → list → claim → set_method → execution → complete ──────
  //
  // The Task surface is what `ExecutionRuntime.admitLinkedTask` transitions on every linked
  // dispatch, and NONE of its eight operations was exercised here. A gate that never creates a
  // Task cannot notice the claim/transition contract breaking.
  {
    const checks = [];
    const created = await mut(token, cwd, 'initiative_task_create', {
      initiative_id: initiative,
      title: 'Smoke Task',
      goal: 'Exercise the Task lifecycle end to end.',
      status: 'open',
      outcome: null,
      workspace_ids: [],
      resource_ids: [],
      // A Task is a NEW entity: its revision is 0. Passing the INITIATIVE's revision is a 409
      // (`expected 2, actual 0`) as soon as an earlier section has advanced it — which every real
      // run does, and a probe run straight after bootstrap does not.
    }, 0);
    checks.push(C('task-create', created.status === 200,
      `status=${created.status} ${created.status === 200 ? '' : JSON.stringify(created.json).slice(0, 160)}`));

    if (created.status === 200) {
      const taskId = created.json.uuid;

      const got = await op(token, cwd, 'initiative_task_get', { uuid: taskId });
      checks.push(C('task-get', got.status === 200 && got.json?.uuid === taskId,
        `status=${got.status} uuid=${got.json?.uuid}`));

      const listed = await op(token, cwd, 'initiative_task_list', { initiative_id: initiative });
      checks.push(C('task-list-contains-it', Array.isArray(listed.json) && listed.json.some((t) => t.uuid === taskId),
        `list=${Array.isArray(listed.json) ? listed.json.length : 'not-an-array'}`));

      // Read the Task's CURRENT revision before every transition rather than threading the one
      // returned by the previous call. A rejected transition (the deliberate second claim below)
      // leaves the caller holding a revision that is no longer the task's, and every subsequent
      // step then 409s — which is exactly what the first version of this section did.
      const taskRev = async () => (await op(token, cwd, 'initiative_task_get', { uuid: taskId })).json?.revision ?? 0;

      const claimed = await mut(token, cwd, 'initiative_task_claim', { uuid: taskId }, await taskRev());
      checks.push(C('task-claim', claimed.status === 200 && claimed.json?.status === 'claimed',
        `status=${claimed.status} task.status=${claimed.json?.status}`));

      // A claimed Task must not be claimable again — the whole point of the claim.
      const reclaim = await mut(token, cwd, 'initiative_task_claim', { uuid: taskId }, await taskRev());
      checks.push(C('task-claim-is-exclusive', reclaim.status >= 400,
        `second claim status=${reclaim.status} — a claimed Task must not be re-claimable`));

      const released = await mut(token, cwd, 'initiative_task_release', { uuid: taskId }, await taskRev());
      checks.push(C('task-release', released.status === 200 && released.json?.status === 'open',
        `status=${released.status} task.status=${released.json?.status}`));

      const withMethod = await mut(token, cwd, 'initiative_task_set_method', {
        initiative: { uuid: initiative }, task: { uuid: taskId }, method: 'software-change@1',
      }, await taskRev());
      checks.push(C('task-set-method', withMethod.status === 200,
        `status=${withMethod.status} ${withMethod.status === 200 ? '' : JSON.stringify(withMethod.json).slice(0, 140)}`));

      // Claim it again before linking an execution: `initiative_task_execution` transitions a
      // CLAIMED task, and the release above deliberately put it back to open.
      await mut(token, cwd, 'initiative_task_claim', { uuid: taskId }, await taskRev());
      const exec = await mut(token, cwd, 'initiative_task_execution', {
        uuid: taskId, execution_ref: 'smoke-execution-ref', transition: 'in_progress',
      }, await taskRev());
      checks.push(C('task-execution-link', exec.status === 200,
        `status=${exec.status} ${exec.status === 200 ? '' : JSON.stringify(exec.json).slice(0, 140)}`));

      const done = await mut(token, cwd, 'initiative_task_complete', {
        uuid: taskId, outcome: 'succeeded',
      }, await taskRev());
      checks.push(C('task-complete', done.status === 200 && done.json?.outcome === 'succeeded',
        `status=${done.status} outcome=${done.json?.outcome}`));
    }
    add(108, 'record_task_lifecycle', checks);
  }

  // ── R9 Decisions, risks, evidence: record → read back → list ────────────────────────────────
  {
    const checks = [];
    const decision = await mut(token, cwd, 'decision_record', {
      initiative_id: initiative,
      title: 'Smoke decision',
      decision: 'Record the decision surface in the smoke run.',
      rationale: 'It was 32% covered and the gate called itself comprehensive.',
      alternatives: ['leave it uncovered'],
      status: 'decided',
    }, 0);
    checks.push(C('decision-record', decision.status === 200, `status=${decision.status}`));
    if (decision.status === 200) {
      const dGet = await op(token, cwd, 'decision_get', { uuid: decision.json.uuid });
      checks.push(C('decision-get', dGet.status === 200 && dGet.json?.uuid === decision.json.uuid, `status=${dGet.status}`));
      const dList = await op(token, cwd, 'decision_list', { initiative_id: initiative });
      checks.push(C('decision-list', Array.isArray(dList.json) && dList.json.length > 0, `n=${dList.json?.length}`));
    }

    const risk = await mut(token, cwd, 'risk_add', {
      initiative_id: initiative, statement: 'Smoke risk', severity: 'low', status: 'open',
    }, 0);
    checks.push(C('risk-add', risk.status === 200, `status=${risk.status}`));
    if (risk.status === 200) {
      const rGet = await op(token, cwd, 'risk_get', { uuid: risk.json.uuid });
      checks.push(C('risk-get', rGet.status === 200, `status=${rGet.status}`));
      const rStatus = await mut(token, cwd, 'risk_status', { uuid: risk.json.uuid, status: 'mitigated' }, rGet.json?.revision ?? 0);
      checks.push(C('risk-status', rStatus.status === 200 && rStatus.json?.status === 'mitigated',
        `status=${rStatus.status} risk.status=${rStatus.json?.status}`));
      const rList = await op(token, cwd, 'risk_list', { initiative_id: initiative });
      checks.push(C('risk-list', Array.isArray(rList.json) && rList.json.length > 0, `n=${rList.json?.length}`));
    }

    const ev = await mut(token, cwd, 'evidence_add', {
      initiative_id: initiative, kind: 'smoke', locator: 'full-smoke://record-surface',
      content_hash: null, summary: 'Evidence recorded by the smoke run.',
    }, 0);
    checks.push(C('evidence-add', ev.status === 200, `status=${ev.status}`));
    if (ev.status === 200 && decision.status === 200) {
      const eGet = await op(token, cwd, 'evidence_get', { uuid: ev.json.uuid });
      checks.push(C('evidence-get', eGet.status === 200, `status=${eGet.status}`));
      const link = await mut(token, cwd, 'evidence_link', {
        evidence_id: ev.json.uuid, target_type: 'decision', target_id: decision.json.uuid,
      }, eGet.json?.revision ?? 0);
      checks.push(C('evidence-link', link.status === 200, `status=${link.status}`));
      const links = await op(token, cwd, 'evidence_links_list', { evidence_id: ev.json.uuid });
      checks.push(C('evidence-links-list', Array.isArray(links.json) && links.json.length > 0, `n=${links.json?.length}`));
      const eList = await op(token, cwd, 'evidence_list', { initiative_id: initiative });
      checks.push(C('evidence-list', Array.isArray(eList.json) && eList.json.length > 0, `n=${eList.json?.length}`));
    }
    add(109, 'record_decisions_risks_evidence', checks);
  }

  // ── R10 The read surface: every catalog/list operation answers ──────────────────────────────
  //
  // Cheap reads, but each is a published operation a caller depends on, and a read that 500s is
  // as broken as a mutation that does. They were unexercised purely because nobody listed them.
  {
    const checks = [];
    const reads = [
      ['product_list', {}],
      ['workspace_list', {}],
      ...(workspaceId ? [['resource_list', { workspace_id: workspaceId }]] : []),
      ['deliverable_list', { initiative_id: initiative }],
      ['requirement_list', { initiative_id: initiative }],
      ['verification_list', { initiative_id: initiative }],
      ['initiative_relations', { initiative_id: initiative }],
      ['method_get', { id: 'software-change@1' }],
      ['delivery_contract_get', { id: 'runnable-software@1' }],
    ];
    for (const [operation, input] of reads) {
      const r = await op(token, cwd, operation, input);
      checks.push(C(operation.replace(/_/g, '-'), r.status === 200,
        `status=${r.status}${r.status === 200 ? '' : ' ' + JSON.stringify(r.json).slice(0, 120)}`));
    }
    // A floor: this loop is only meaningful if it ran. An empty `reads` would report nothing.
    checks.push(C('read-surface-exercised', checks.length === reads.length,
      `${checks.length}/${reads.length} read operations called`));
    add(110, 'record_read_surface', checks);
  }

  // ── R11 The rest of the surface: catalogue reads, entity creation, supersession, delivery ────
  //
  // The last 19 operations. Every payload here was probed against a live daemon before being
  // written — which is how the two that matter came out: an operation that CREATES a new entity
  // takes `expected_revision: 0` (the entity does not exist yet, so its revision is 0), NOT the
  // initiative's revision, and `deliverable_attach_artifact`'s `requirement` must be one the
  // Delivery Contract declares (`runnable-software@1` requires source_changes, run_instructions,
  // successful_build, automated_checks, runnable_preview). Both were 400/409 when guessed.
  {
    const checks = [];
    const revNow = async () => (await op(token, cwd, 'initiative_get', { uuid: initiative })).json?.revision;

    // Catalogue reads by id.
    if (productId) {
      checks.push(C('product-get', (await op(token, cwd, 'product_get', { uuid: productId })).status === 200, `product=${productId}`));
    }
    if (workspaceId) {
      checks.push(C('workspace-get', (await op(token, cwd, 'workspace_get', { uuid: workspaceId })).status === 200, `workspace=${workspaceId}`));
    }
    const newProduct = await mut(token, cwd, 'product_create', { name: 'Smoke Product B', slug: `smoke-b-${suffix}` }, 0);
    checks.push(C('product-create', newProduct.status === 200, `status=${newProduct.status}`));

    // Requirement → acceptance criterion → verification, read back at each step.
    const reqs = await op(token, cwd, 'requirement_list', { initiative_id: initiative });
    const reqId = (reqs.json ?? [])[0]?.uuid;
    checks.push(C('requirement-get', reqId
      ? (await op(token, cwd, 'requirement_get', { uuid: reqId })).status === 200
      : false, `requirement=${reqId ?? 'none seeded'}`));

    let criterionId = null;
    if (reqId) {
      const ac = await mut(token, cwd, 'acceptance_criterion_add',
        { requirement_id: reqId, statement: 'Smoke criterion', check_reference: 'true' }, 0);
      criterionId = ac.json?.uuid ?? null;
      checks.push(C('acceptance-criterion-add', ac.status === 200, `status=${ac.status}`));
      checks.push(C('acceptance-criterion-list',
        (await op(token, cwd, 'acceptance_criterion_list', { requirement_id: reqId })).status === 200, ''));
      if (criterionId) {
        checks.push(C('acceptance-criterion-get',
          (await op(token, cwd, 'acceptance_criterion_get', { uuid: criterionId })).status === 200, ''));
        const vr = await mut(token, cwd, 'verification_record',
          { initiative_id: initiative, acceptance_criterion_id: criterionId, method: 'human', state: 'pass', detail: 'smoke' }, 0);
        checks.push(C('verification-record', vr.status === 200, `status=${vr.status}`));
        if (vr.json?.uuid) {
          checks.push(C('verification-get',
            (await op(token, cwd, 'verification_get', { uuid: vr.json.uuid })).status === 200, ''));
        }
      }
    }

    // Artifacts. `description` is REQUIRED; omitting it is a 400, not a default.
    const artifact = await mut(token, cwd, 'artifact_register',
      { initiative_id: initiative, storage_mode: 'external', path_or_uri: 'smoke://artifact', description: 'Smoke artifact' }, 0);
    checks.push(C('artifact-register', artifact.status === 200, `status=${artifact.status}`));
    if (artifact.json?.uuid) {
      checks.push(C('artifact-get', (await op(token, cwd, 'artifact_get', { uuid: artifact.json.uuid })).status === 200, ''));
    }

    // Supersession: a Decision is replaced, not edited.
    const older = await mut(token, cwd, 'decision_record',
      { initiative_id: initiative, title: 'Superseded decision', decision: 'first', rationale: 'r', alternatives: [], status: 'decided' }, 0);
    if (older.status === 200) {
      const olderRead = await op(token, cwd, 'decision_get', { uuid: older.json.uuid });
      const superseded = await mut(token, cwd, 'decision_supersede',
        { uuid: older.json.uuid, title: 'Superseding decision', decision: 'second', rationale: 'r2', alternatives: [] },
        olderRead.json?.revision);
      checks.push(C('decision-supersede', superseded.status === 200, `status=${superseded.status}`));
    }

    // A second Initiative, related to the first.
    if (productId) {
      const second = await mut(token, cwd, 'initiative_create',
        { product_id: productId, title: 'Smoke related initiative', goal: 'Prove relate + create.', status: 'open', outcome: null }, 0);
      checks.push(C('initiative-create', second.status === 200, `status=${second.status}`));
      if (second.json?.uuid) {
        checks.push(C('initiative-relate', (await mut(token, cwd, 'initiative_relate',
          { from_id: initiative, to_id: second.json.uuid, type: 'related_to' }, 0)).status === 200, ''));
      }
    }

    // Lifecycle: status, contract, and the two phase transitions the earlier section never drives.
    checks.push(C('initiative-status', (await mut(token, cwd, 'initiative_status',
      { uuid: initiative, status: 'open', outcome: null }, await revNow())).status === 200, ''));
    checks.push(C('initiative-set-lifecycle-contract', (await mut(token, cwd, 'initiative_set_lifecycle_contract',
      { initiative: { uuid: initiative }, lifecycle_contract: null }, await revNow())).status === 200, ''));
    checks.push(C('initiative-phase-skip', (await mut(token, cwd, 'initiative_phase_skip',
      { initiative: { uuid: initiative }, phase: 'discover', reason: 'smoke: skip then reopen' }, await revNow())).status === 200, ''));
    checks.push(C('initiative-phase-reopen', (await mut(token, cwd, 'initiative_phase_reopen',
      { initiative: { uuid: initiative }, phase: 'discover', reason: 'smoke: reopen after skip' }, await revNow())).status === 200, ''));

    // Delivery: attach an artifact against a DECLARED requirement, then approve.
    const dl = await mut(token, cwd, 'deliverable_define',
      { initiative_id: initiative, target_type: 'runnable-software', delivery_contract: 'runnable-software@1' }, 0);
    if (dl.status === 200 && artifact.json?.uuid) {
      checks.push(C('deliverable-attach-artifact', (await mut(token, cwd, 'deliverable_attach_artifact',
        { deliverable_id: dl.json.uuid, artifact_id: artifact.json.uuid, requirement: 'source_changes' },
        dl.json.revision)).status === 200, 'requirement must be one the Delivery Contract declares'));
      const dlRead = await op(token, cwd, 'deliverable_get', { uuid: dl.json.uuid });
      checks.push(C('deliverable-approve', (await mut(token, cwd, 'deliverable_approve',
        { deliverable: { uuid: dl.json.uuid }, reason: 'smoke approval' }, dlRead.json?.revision)).status === 200, ''));
      checks.push(C('deliverable-list',
        (await op(token, cwd, 'deliverable_list', { initiative_id: initiative })).status === 200, ''));
    }

    // Floor: this section is only meaningful if it actually ran its calls.
    checks.push(C('rest-of-surface-exercised', checks.length >= 18, `${checks.length} operations checked`));
    add(111, 'record_remaining_surface', checks);
  }

  // ── R12 portability: a snapshot must carry what its own Tasks point at ──────────────────────
  //
  // `initiative_export` selects Workspaces from `initiative_workspace_links`, but a Task's
  // `workspace_ids` are stored independently. A Task referencing a Workspace the snapshot omits
  // re-imports with a reference that resolves to nothing, and export, import, and a count-based
  // diff all stay silent about it — an entity count of `0 -> 0` cannot tell "nothing to carry"
  // from "carried nothing". Assert the reference, not the count.
  {
    const checks = [];
    const productId = (await op(token, cwd, 'initiative_get', { uuid: initiative })).json?.product_id;
    const ws = await mut(token, cwd, 'workspace_create',
      { product_id: productId, name: 'Portability workspace', slug: `portable-${suffix}`,
        description: 'Referenced by a Task, so the snapshot must carry it.' }, 0);
    if (ws.status === 200) {
      await mut(token, cwd, 'initiative_link_workspace',
        { initiative_id: initiative, workspace_id: ws.json.uuid, role: 'references' }, 0);
      await mut(token, cwd, 'initiative_task_create',
        { initiative_id: initiative, title: 'Portability Task', goal: 'Reference a Workspace across an export.',
          status: 'open', outcome: null, workspace_ids: [ws.json.uuid], resource_ids: [] }, 0);
    }

    const exported = await op(token, cwd, 'initiative_export', { initiative: { uuid: initiative } });
    const snapshot = exported.json ?? {};
    const carried = new Set((snapshot.workspaces ?? []).map((w) => w.workspace?.uuid ?? w.uuid));
    const referenced = [...new Set((snapshot.tasks ?? []).flatMap((t) => t.workspace_ids ?? []))];
    const dangling = referenced.filter((id) => !carried.has(id));

    checks.push(C('export-succeeds', exported.status === 200, `status=${exported.status}`));
    // Floor: an assertion over an empty reference set proves nothing.
    checks.push(C('export-has-references-to-check', referenced.length > 0,
      `${referenced.length} Workspace reference(s) across ${(snapshot.tasks ?? []).length} exported Task(s)`));
    checks.push(C('export-carries-referenced-workspaces', dangling.length === 0,
      dangling.length === 0
        ? `all ${referenced.length} referenced Workspace(s) present in the snapshot`
        : `${dangling.length} referenced Workspace(s) MISSING from the snapshot: ${dangling.join(', ')}`));
    add(112, 'record_portability', checks);
  }

  return { records, checksByScenario };
}
