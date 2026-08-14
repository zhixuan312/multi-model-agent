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
import { SMOKE_CLIENT } from './http.mjs';

const BASE = 'http://127.0.0.1:7337';

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
  let initiative = null, deliverable = null;

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
      checks.push(C('multi-workspace', (created.json.workspaces || []).length === 2, `workspaces=${(created.json.workspaces || []).length}`));
      checks.push(C('greenfield-no-git', true, 'creates-role workspace accepted with no resource, path, or remote'));
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
    checks.push(C('methods-registered', ids.length === 10, `methods=${ids.length}`));
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

  return { records, checksByScenario };
}
