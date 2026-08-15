import { existsSync, readFileSync } from 'node:fs';
import { SANDBOX_ESCAPE_TARGETS } from './dispatch.mjs';
import { SCHEMA_VERSION, configuredMainModel, configuredWorkerModels } from './config.mjs';
import { SMOKE_CLIENT } from './http.mjs';
// The component catalog is defined ONCE, in the core package (AC-5.4). A second copy here could
// only ever agree with itself: if the catalog changed, this harness would keep asserting the old
// identifiers and report a passing spec while the product emitted something else.
import { SPEC_COMPONENTS } from '../../packages/core/dist/index.js';
const CANON = SPEC_COMPONENTS;

const C = (checkId, status, detail = '') => ({ checkId, status, detail });

// ─────────────────────────────────────────────────────────────────────────────
// Verify checks per scenario. Every scenario validates:
//
//   1. response      — did the task complete successfully?
//   2. sessions      — are session fields present and correct?
//   3. tier          — does the implementer tier match expected?
//   4. review        — is reviewer present when reviewed, absent when none?
//   5. quality       — does the output contain meaningful, type-appropriate content?
//   6. context-block — contextBlockId non-null for read types, null for write?
//   7. cost          — implementer costUsd > 0?
//   8. diag-events   — expected diagnostic events present?
// ─────────────────────────────────────────────────────────────────────────────

// Quality assertions per task type. Returns [status, detail].
function extractFindingsFromOutput(output) {
  if (!output) return [];
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1][1]);
    return parsed.findings ?? [];
  } catch { return []; }
}

function checkQuality(type, subtype, r, subsetComponents) {
  // Extract output text: prefer raw implementer text, then output.summary as string
  const rawImpl = r?.raw?.implementer ?? '';
  const summary = r?.output?.summary;
  const output = typeof rawImpl === 'string' && rawImpl.length > 0
    ? rawImpl
    : (typeof summary === 'string' ? summary : JSON.stringify(summary ?? ''));
  const outputLen = typeof output === 'string' ? output.length : 0;

  switch (type) {
    case 'audit': {
      const findings = extractFindingsFromOutput(output);
      if (outputLen < 200) return ['FAIL', `audit output too short (${outputLen} chars)`];
      if (findings.length > 0) {
        const withEvidence = findings.filter(f => f?.evidence?.length > 20);
        return ['PASS', `${findings.length} findings, ${withEvidence.length} grounded, ${outputLen} chars`];
      }
      // Audits (especially plan/skill subtypes) may return prose analysis
      // without a JSON findings block — substantive prose is valid output.
      return ['PASS', `prose audit output (${outputLen} chars, no JSON findings block)`];
    }
    case 'investigate': {
      if (outputLen < 100) return ['FAIL', `output too short (${outputLen} chars) — expected substantive analysis`];
      const citesFile = /\b\w+\.\w+:\d+\b|file:|line\s+\d+/i.test(output);
      return [citesFile ? 'PASS' : 'WARN', `${outputLen} chars; file-citation=${citesFile}`];
    }
    case 'review': {
      const reviewFindings = extractFindingsFromOutput(output);
      if (reviewFindings.length === 0 && outputLen < 50) return ['WARN', 'review produced 0 findings and minimal output'];
      return ['PASS', `${reviewFindings.length} findings, ${outputLen} chars output`];
    }
    case 'debug': {
      if (outputLen < 100) return ['FAIL', `debug output too short (${outputLen} chars) — expected root-cause trace`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'research': {
      if (outputLen < 200) return ['WARN', `research output short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'journal_recall': {
      if (outputLen < 20) return ['WARN', `recall output very short (${outputLen} chars)`];
      const findings = Array.isArray(summary?.findings) ? summary.findings : [];
      if (findings.length > 0) {
        const badTopic = findings.filter(f => typeof f?.topic !== 'string' || f.topic.length === 0);
        if (badTopic.length > 0) return ['FAIL', `${badTopic.length}/${findings.length} recall findings missing a topic`];
        const badFallback = findings.filter(f => typeof f?.fallback !== 'boolean');
        if (badFallback.length > 0) return ['FAIL', `${badFallback.length}/${findings.length} recall findings missing a boolean fallback flag`];
        return ['PASS', `${findings.length} findings, all carry topic + boolean fallback`];
      }
      return ['PASS', `${outputLen} chars output (0 findings)`];
    }
    case 'journal_record': {
      if (outputLen < 10) return ['WARN', `record output very short (${outputLen} chars)`];
      const hasType = /\btype\b/.test(output) || /decision|design|behavior|process|knowledge|style/.test(output);
      const recorded = Array.isArray(summary?.recorded) ? summary.recorded : [];
      if (recorded.length > 0) {
        const missingTopic = recorded.filter(x => typeof x?.topic !== 'string' || x.topic.length === 0);
        if (missingTopic.length > 0) return ['FAIL', `${missingTopic.length}/${recorded.length} recorded items missing a topic`];
        const allKebab = recorded.every(x => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x.topic));
        if (!allKebab) return ['FAIL', `recorded topic is not normalized lowercase-kebab`];
        return ['PASS', `${recorded.length} recorded, all carry lowercase-kebab topic; type-aware=${hasType}`];
      }
      return ['PASS', `${outputLen} chars output; type-aware=${hasType}`];
    }
    case 'delegate': {
      if (outputLen < 20) return ['WARN', `delegate output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'execute_plan': {
      if (outputLen < 20) return ['WARN', `execute_plan output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'orchestrate': {
      if (outputLen < 50) return ['FAIL', `orchestrate output too short (${outputLen} chars) — expected structured response`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'spec': {
      if (outputLen < 20) return ['WARN', `spec output very short (${outputLen} chars)`];
      const specSummary = r?.output?.summary;
      const specPath = specSummary?.specPath ?? null;
      const hasSpecPath = specPath != null;
      // Default artifact root is .mma/specs/ (co-located with the journal). Scenario
      // #24 sends no outputPath, so the derived path must land under .mma/specs/ —
      // regression guard. The worker may return an absolute worktree path, so match
      // the .mma/specs/ segment (not a leading anchor) and reject the old docs/mma root.
      const specStr = String(specPath);
      if (hasSpecPath && (!/(^|\/)\.mma\/specs\//.test(specStr) || specStr.includes('docs/mma'))) {
        return ['FAIL', `specPath not under .mma/specs/: ${specPath}`];
      }
      const sections = specSummary?.sections ?? [];
      if (subsetComponents) {
        // Subset spec: pass iff sections equals exactly the requested set in canonical order.
        const want = CANON.filter(c => subsetComponents.includes(c));
        const exact = sections.length === want.length && want.every((c, i) => sections[i] === c);
        return [exact ? 'PASS' : 'FAIL', `subset spec; specPath=${hasSpecPath}; sections=${JSON.stringify(sections)} (want ${JSON.stringify(want)})`];
      }
      const missingComponents = CANON.filter(c => !sections.includes(c));
      const forgeCompat = missingComponents.length === 0;
      return [forgeCompat ? 'PASS' : 'WARN', `${outputLen} chars; specPath=${hasSpecPath}; forge-compat=${forgeCompat}${missingComponents.length > 0 ? ` missing=[${missingComponents.join(',')}]` : ''}`];
    }
    case 'plan': {
      if (outputLen < 20) return ['WARN', `plan output very short (${outputLen} chars)`];
      const planSummary = r?.output?.summary;
      const planPath = planSummary?.planPath ?? null;
      const hasPlanPath = planPath != null;
      // Default artifact root is .mma/plans/ (co-located with the journal). Scenario
      // #25 sends no outputPath, so the derived path must land under .mma/plans/ —
      // regression guard. The worker may return an absolute worktree path, so match
      // the .mma/plans/ segment (not a leading anchor) and reject the old docs/mma root.
      const planStr = String(planPath);
      if (hasPlanPath && (!/(^|\/)\.mma\/plans\//.test(planStr) || planStr.includes('docs/mma'))) {
        return ['FAIL', `planPath not under .mma/plans/: ${planPath}`];
      }
      return ['PASS', `${outputLen} chars output; planPath=${planPath ?? 'none'}`];
    }
    default:
      return ['PASS', `${outputLen} chars output (no type-specific quality check)`];
  }
}

/**
 * The message fragment each contract-rejection scenario must produce, keyed by scenario type.
 *
 * These are deliberately the ENGINE's own wording rather than a paraphrase. If a message is
 * reworded the smoke fails loudly, which is correct: the text is what a caller reads to fix
 * their contract, so changing it is a caller-visible change that deserves a deliberate edit
 * here. A looser assertion (any 400) would pass even when the wrong invariant fired.
 */
const CONTRACT_REJECTION_REASON = {
  // Only `state: 'approved'` crosses the wire — Zod reports the failed literal.
  error_contract_not_approved: 'expected "approved"',
  // INV-7: the approval must cover THIS content.
  error_contract_digest_mismatch: 'contractApproval.contractDigest does not match the canonical digest',
  // INV-3, and only reachable with a real non-git workspace on disk.
  error_contract_disposition_non_git: 'requires the workspace root to be a git repository',
  // `method` is wired to every route (unlike the retired field this replaces), so an
  // unregistered-but-well-formed identifier fails at resolution rather than at schema shape —
  // no `CONTRACT_REJECTION_REASON` entry here; `error_unknown_method` is asserted generically
  // below (http-status + error-body), since the store's `unknown_method` error is a top-level
  // `{ error: { code, message } }`, not a field-specific `deliverable`/form error.
};

export function verify(rec) {
  const out = [];
  const { response: r, diagnostics: d, queue: q, backend: b, expect: e } = rec;

  // ─── Error cases: validate HTTP 400 ───
  if (e.kind === 'error') {
    const status = rec.errorStatus;
    const json = rec.errorJson;
    out.push(C('http-status', status === e.expectStatus ? 'PASS' : 'FAIL',
      `expected=${e.expectStatus} got=${status}`));
    const hasError = json && (json.error || json.message || json.code);
    out.push(C('error-body', hasError ? 'PASS' : 'WARN',
      `body=${JSON.stringify(json).slice(0, 200)}`));

    // #50 is a resolution regression, not merely a malformed request: the registered-field
    // syntax must survive schema validation and reach the Method Registry's unknown-method
    // branch. A generic 400 would also pass if `method` stopped being wired on this route.
    if (e.type === 'error_unknown_method') {
      out.push(C('unknown-method-code', json?.error?.code === 'unknown_method' ? 'PASS' : 'FAIL',
        `error.code=${json?.error?.code}`));
    }

    // A 400 alone does not prove the RIGHT invariant rejected the request — any typo in a
    // rejection fixture also yields 400. Each contract scenario therefore names the message
    // fragment its own invariant produces, and asserts the response actually contains it.
    // `CONTRACT_REJECTION_REASON` is keyed by scenario type, so a scenario without an entry
    // keeps the generic checks above and nothing here.
    const wantedReason = CONTRACT_REJECTION_REASON[e.type];
    if (wantedReason) {
      // Field-specific errors must land UNDER `deliverable` (or as a form-level unrecognized
      // key), never as a bare form error — a caller fixes what the field path points at.
      const details = json?.error?.details?.fieldErrors ?? {};
      const deliverableErrors = Array.isArray(details?.fieldErrors?.deliverable) ? details.fieldErrors.deliverable : [];
      const formErrors = Array.isArray(details?.formErrors) ? details.formErrors : [];
      // Match against the RAW message strings, never against `JSON.stringify(body)`. Several
      // engine messages quote a literal (`expected "approved"`), and stringifying the body
      // escapes those quotes, so a substring search over the serialised form fails on a
      // message that is in fact present — a false failure that hides the real signal.
      const messages = [...deliverableErrors, ...formErrors, json?.error?.message ?? ''];
      out.push(C('contract-rejection-reason',
        messages.some((m) => String(m).includes(wantedReason)) ? 'PASS' : 'FAIL',
        `want=${JSON.stringify(wantedReason)} messages=${JSON.stringify(messages).slice(0, 260)}`));
      out.push(C('contract-error-is-field-specific',
        deliverableErrors.length > 0 || formErrors.length > 0 ? 'PASS' : 'FAIL',
        `deliverableErrors=${deliverableErrors.length} formErrors=${formErrors.length}`));
    }
    return out;
  }

  // ─── Assist routes (context-blocks): minimal envelope check ───
  if (e.kind === 'assist') {
    out.push(C('register', r && r.execution ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    return out;
  }

  // ─── Cooperative cancellation (#39): DELETE /execution/:id ───
  //     202 means REQUESTED, not stopped. The contract is the whole lifecycle:
  //     the ack carries the flag, a poll taken immediately after still reports
  //     `running` WITH the flag, and only once the runner confirms termination
  //     does the task seal as `cancelled`. The reviewer must never have run —
  //     cancellation has to stop the pipeline before review, or a half-finished
  //     draft would get refined into a fabricated answer.
  if (e.kind === 'cancel') {
    const c = rec.cancel ?? {};
    out.push(C('cancel-202', c.status === 202 ? 'PASS' : 'FAIL', `status=${c.status}`));
    out.push(C('cancel-ack', c.body?.cancellationRequested === true && c.body?.status === 'running'
      ? 'PASS' : 'FAIL', `body=${JSON.stringify(c.body)}`));

    const p = rec.pollAfterCancel ?? {};
    // Tolerate the race where the runner tore down between the ack and this poll.
    const midFlight = p.status === 202 && p.body?.cancellationRequested === true;
    const alreadyTerminal = p.status === 200;
    out.push(C('cancel-flag-visible', midFlight || alreadyTerminal ? 'PASS' : 'FAIL',
      `status=${p.status} flag=${p.body?.cancellationRequested}`));

    out.push(C('terminal-cancelled', r?.execution?.status === 'cancelled' ? 'PASS' : 'FAIL',
      `status=${r?.execution?.status}`));
    out.push(C('cancel-error-code', r?.error?.code === 'aborted' ? 'PASS' : 'FAIL',
      `error=${JSON.stringify(r?.error)}`));
    out.push(C('reviewer-skipped', r?.metrics?.reviewer === null ? 'PASS' : 'FAIL',
      `reviewer=${JSON.stringify(r?.metrics?.reviewer)}`));

    const rd = rec.repeatCancel ?? {};
    out.push(C('cancel-idempotent',
      rd.status === 200 && rd.body?.alreadyTerminal === true && rd.body?.status === 'cancelled'
        ? 'PASS' : 'FAIL', `status=${rd.status} body=${JSON.stringify(rd.body)}`));

    const keys = Object.keys(r ?? {}).sort();
    out.push(C('layered-200',
      JSON.stringify(keys) === JSON.stringify(['error', 'execution', 'metrics', 'output', 'raw'])
        ? 'PASS' : 'FAIL', `keys=${keys.join(',')}`));
    return out;
  }

  // ─── A caller that lost its handle (#59) ───
  if (e.kind === 'client-timeout') {
    const c = rec.clientTimeout ?? {};
    out.push(C('inflight-dispatch-admitted', c.dispatched ? 'PASS' : 'FAIL',
      `dispatched=${c.dispatched} taskId=${c.taskId}`));
    // The load-bearing assertion. Without it, a timed-out caller cannot tell "created" from
    // "not created", and re-dispatching — duplicating the work — is the only safe move.
    out.push(C('inflight-task-discoverable', c.discovered ? 'PASS' : 'FAIL',
      `the running task ${c.discovered ? 'was' : 'was NOT'} listed among ${c.listedCount} live tasks — `
      + `a caller that lost its handle must be able to reconcile instead of re-dispatching`));
    return out;
  }

  // ─── MCP carrying the new request fields (#55) ───
  //     The generated MCP request schema comes from the same Zod union REST validates with, so
  //     these assertions catch a generation bug or an adapter that strips unknown keys — either
  //     of which would leave a contract accepted over REST and rejected over MCP.
  if (e.kind === 'mcp-contract') {
    const m = rec.mcpContract ?? {};
    const toolText = JSON.stringify(m.schema?.json?.result ?? {});
    out.push(C('mcp-schema-exposes-deliverable', toolText.includes('deliverable') ? 'PASS' : 'FAIL',
      'the generated mma_run schema must advertise the contract field'));
    out.push(C('mcp-schema-exposes-method', toolText.includes('method') ? 'PASS' : 'FAIL',
      'the generated mma_run schema must advertise the method field'));
    // A taskId proves the adapter ACCEPTED both fields: a rejection returns a tool error instead.
    out.push(C('mcp-contract-accepted', m.taskId ? 'PASS' : 'FAIL',
      m.taskId ? `taskId=${m.taskId}` : `no taskId — payload=${JSON.stringify(m.runPayload).slice(0, 220)}`));
    out.push(C('mcp-method-echoed', r?.execution?.method === 'software-change@1' ? 'PASS' : 'FAIL',
      `execution.method=${r?.execution?.method} (must survive the MCP path exactly as it does over REST)`));
    out.push(C('mcp-terminal-clean', r?.execution?.status && !r?.error ? 'PASS' : 'FAIL',
      `status=${r?.execution?.status} error=${JSON.stringify(r?.error)}`));
    return out;
  }

  // ─── The remaining MCP tools (#56) ───
  //     `mma_run` and `mma_task_wait` are covered by #40; these four had never been driven over
  //     MCP at all, so a tool that threw on every call would have failed no scenario.
  if (e.kind === 'mcp-tools') {
    const m = rec.mcpTools ?? {};
    out.push(C('mcp-context-block-create', m.blockId ? 'PASS' : 'FAIL', `blockId=${m.blockId}`));
    const listed = Array.isArray(m.listPayload?.executions) ? m.listPayload.executions
      : (Array.isArray(m.listPayload) ? m.listPayload : null);
    out.push(C('mcp-task-list', listed !== null ? 'PASS' : 'FAIL',
      `executions=${listed ? listed.length : 'not an array'} — the tool must return an execution collection`));
    out.push(C('mcp-task-get', m.getPayload?.executionId === m.taskId ? 'PASS' : 'FAIL',
      `returned executionId=${m.getPayload?.executionId} want=${m.taskId}`));
    // Cancellation is REQUESTED, so either acknowledgement shape is correct; what must not happen
    // is the tool failing to answer at all.
    // A non-null payload is NOT an ack. An MCP tool error carries a parseable `{error:{...}}` body
    // too, so the old "did it parse" check scored a rejected cancel as a successful one. The ack
    // has a shape — `cancellationRequested: true` on the execution we asked about — and that shape
    // is what proves the request reached the runtime.
    const ack = m.cancelPayload;
    const cancelOk = m.cancelIsError === false
      && ack?.cancellationRequested === true
      && ack?.executionId === m.taskId;
    out.push(C('mcp-task-cancel', cancelOk ? 'PASS' : 'FAIL',
      `isError=${m.cancelIsError} ack=${JSON.stringify(ack)}`));
    out.push(C('mcp-cancel-reached-terminal', ['cancelled', 'done', 'done_with_concerns', 'failed'].includes(m.terminal?.execution?.status) ? 'PASS' : 'WARN',
      `terminal status=${m.terminal?.execution?.status}`));
    out.push(C('mcp-context-block-delete', m.deleteBlock !== null && m.deleteBlock !== undefined ? 'PASS' : 'WARN',
      `delete=${JSON.stringify(m.deleteBlock)}`));
    return out;
  }

  // ─── MCP adapter (#40): POST /mcp, second transport over the SAME runtime ───
  if (e.kind === 'mcp') {
    const m = rec.mcp ?? {};
    const serverInfo = m.init?.json?.result?.serverInfo;
    out.push(C('mcp-initialize', serverInfo?.name === 'multi-model-agent' ? 'PASS' : 'FAIL',
      `serverInfo=${JSON.stringify(serverInfo)}`));

    // The handshake is a PROMISE about what this daemon can serve, and until 6.2.1
    // nothing here read it. A released daemon advertised tools-only for ten months
    // because it could not find its own bundle (see execution-artifact.ts); the
    // smoke ran green throughout, since the monorepo is the one layout where the
    // lookup worked. A build that carries the App must SAY it carries the App.
    const caps = m.init?.json?.result?.capabilities ?? {};
    const advertisesApp = Object.prototype.hasOwnProperty.call(caps, 'resources')
      && Object.prototype.hasOwnProperty.call(caps.extensions ?? {}, 'io.modelcontextprotocol/ui');
    out.push(C('mcp-capabilities', advertisesApp ? 'PASS' : 'FAIL',
      advertisesApp
        ? 'resources + io.modelcontextprotocol/ui advertised'
        : `capabilities=${JSON.stringify(caps)} — the daemon degraded to tools-only, so it could not read dist/ui/execution.html`));
    out.push(C('mcp-tools-with-app', Object.prototype.hasOwnProperty.call(caps, 'tools') ? 'PASS' : 'FAIL',
      `tools capability present=${Object.prototype.hasOwnProperty.call(caps, 'tools')} (must hold in BOTH capability sets)`));

    // Advertising it is not serving it. The host lists, then reads; both have to
    // work, and the bytes have to be the real bundle rather than the placeholder
    // the loader substitutes when the file is missing.
    const listed = m.resourceList?.json?.result?.resources ?? [];
    const appResource = listed.find((x) => String(x?.uri ?? '').startsWith('ui://mma/execution.html'));
    out.push(C('mcp-resources-list', appResource ? 'PASS' : 'FAIL',
      `resources=${JSON.stringify(listed.map((x) => x?.uri))}`));

    // Content-addressed URI: hosts cache hard, so a rebuilt bundle MUST arrive
    // under a new name or an upgraded user keeps running the old App forever.
    out.push(C('mcp-resource-fingerprinted', /\?v=[0-9a-f]{8}$/.test(appResource?.uri ?? '') ? 'PASS' : 'FAIL',
      `uri=${appResource?.uri}`));

    const readContent = m.resourceRead?.json?.result?.contents?.[0];
    const html = readContent?.text ?? '';
    const realBundle = html.length > 100000 && !html.includes('not built');
    out.push(C('mcp-resource-read', realBundle ? 'PASS' : 'FAIL',
      `mimeType=${readContent?.mimeType} bytes=${html.length}${html.includes('not built') ? ' — served the unbuilt placeholder' : ''}`));
    out.push(C('mcp-resource-mime', readContent?.mimeType === 'text/html;profile=mcp-app' ? 'PASS' : 'FAIL',
      `mimeType=${readContent?.mimeType} want=text/html;profile=mcp-app`));

    // A deliberate golden, not a derived list: growing or shrinking the MCP tool
    // surface is a wire-contract change every consumer feels, so it should require
    // editing this line. (It went stale once — `mma_task_list` and the two
    // context-block tools shipped while this still expected the original four; then the whole
    // record surface shipped while this still expected the pre-SPEC-003 task vocabulary, which
    // is exactly what this run caught.)
    const toolNames = (m.tools?.json?.result?.tools ?? []).map((t) => t.name).sort();
    const expected = [
      'mma_acceptance_criterion_add', 'mma_acceptance_criterion_get', 'mma_acceptance_criterion_list', 'mma_artifact_get',
      'mma_artifact_register', 'mma_context_block_create', 'mma_context_block_delete', 'mma_decision_get',
      'mma_decision_list', 'mma_decision_record', 'mma_decision_supersede', 'mma_deliverable_approve',
      'mma_deliverable_attach_artifact', 'mma_deliverable_define', 'mma_deliverable_deliver', 'mma_deliverable_get',
      'mma_deliverable_list', 'mma_deliverable_package', 'mma_deliverable_validate', 'mma_delivery_contract_get',
      'mma_delivery_contract_list', 'mma_evidence_add', 'mma_evidence_get', 'mma_evidence_link',
      'mma_evidence_links_list', 'mma_evidence_list', 'mma_execution_cancel', 'mma_execution_get',
      'mma_execution_list', 'mma_execution_wait', 'mma_initiative_bootstrap', 'mma_initiative_create',
      'mma_initiative_export', 'mma_initiative_focus_set', 'mma_initiative_gate_status', 'mma_initiative_get',
      'mma_initiative_import', 'mma_initiative_initiative_task_set_method', 'mma_initiative_link_workspace', 'mma_initiative_list',
      'mma_initiative_method_get', 'mma_initiative_method_list', 'mma_initiative_phase_enter', 'mma_initiative_phase_reopen',
      'mma_initiative_phase_satisfy', 'mma_initiative_phase_skip', 'mma_initiative_relate', 'mma_initiative_relations',
      'mma_initiative_resume', 'mma_initiative_set_lifecycle_contract', 'mma_initiative_status', 'mma_initiative_task_claim',
      'mma_initiative_task_complete', 'mma_initiative_task_create', 'mma_initiative_task_execution', 'mma_initiative_task_get',
      'mma_initiative_task_list', 'mma_initiative_task_release', 'mma_product_create', 'mma_product_get',
      'mma_product_list', 'mma_requirement_add', 'mma_requirement_get', 'mma_requirement_list',
      'mma_resource_list', 'mma_resource_register', 'mma_risk_add', 'mma_risk_get',
      'mma_risk_list', 'mma_risk_status', 'mma_run', 'mma_verification_get',
      'mma_verification_list', 'mma_verification_record', 'mma_verification_run', 'mma_workspace_create',
      'mma_workspace_get', 'mma_workspace_list',
    ];
    out.push(C('mcp-tools', JSON.stringify(toolNames) === JSON.stringify(expected) ? 'PASS' : 'FAIL',
      `tools=${toolNames.join(',')}`));

    // And what the published plugin TELLS users it exposes must be the same set.
    // The README is generated from a hand-written sentence in build-plugin.ts, so
    // it is exactly the kind of thing that drifts silently from the live surface —
    // a user reads it, asks for a tool that no longer exists, and the failure looks
    // like their mistake.
    try {
      const readme = readFileSync(new URL('../../plugin/README.md', import.meta.url), 'utf8');
      const advertised = [...readme.matchAll(/`(mma_[a-z_]+)`/g)].map((x) => x[1]);
      const missing = toolNames.filter((t) => !advertised.includes(t));
      const phantom = [...new Set(advertised)].filter((t) => !toolNames.includes(t));
      out.push(C('mcp-tools-documented', missing.length === 0 && phantom.length === 0 ? 'PASS' : 'FAIL',
        missing.length === 0 && phantom.length === 0
          ? `plugin README advertises exactly the ${toolNames.length} live tools`
          : `undocumented=[${missing.join(',')}] advertised-but-absent=[${phantom.join(',')}]`));
    } catch (err) {
      out.push(C('mcp-tools-documented', 'FAIL', `could not read plugin/README.md: ${err.message}`));
    }

    // mma_run's request schema is GENERATED from the task-input Zod union — one
    // variant per task type. A hand-written schema would drift; this catches it.
    const runTool = (m.tools?.json?.result?.tools ?? []).find((t) => t.name === 'mma_run');
    const reqSchema = runTool?.inputSchema?.properties?.request;
    const variants = reqSchema?.oneOf ?? reqSchema?.anyOf ?? [];
    out.push(C('mcp-generated-schema', variants.length === 12 ? 'PASS' : 'FAIL',
      `request variants=${variants.length} (expected 12, one per task type)`));

    out.push(C('mcp-run-handle', m.taskId ? 'PASS' : 'FAIL',
      `payload=${JSON.stringify(m.runPayload).slice(0, 160)}`));

    const w = m.waitPayload;
    out.push(C('mcp-terminal', w?.execution?.status && w.execution.status !== 'failed' ? 'PASS' : 'FAIL',
      `status=${w?.execution?.status} error=${JSON.stringify(w?.error)}`));

    // `mma_execution_wait` is capped at 55s by design (MCP hosts give up around 60s), so a task
    // slower than that returning before terminal is CORRECT, not a defect — reported, never failed.
    out.push(C('mcp-wait-bounded', 'PASS',
      m.waitReachedTerminal === true
        ? 'mma_execution_wait returned the terminal envelope within its 55s cap'
        : 'wait returned before terminal (task outran the 55s cap, as designed); parity uses mma_execution_get'));

    // THE load-bearing assertion: the same execution read over MCP and over REST must be
    // byte-identical — one runtime, two transports, no duplicated state.
    //
    // Compares the MCP `mma_execution_get` read, NOT the wait payload. The wait payload silently
    // becomes a REST envelope whenever the task outruns the cap, which turned this into REST-vs-REST
    // on every long task — the assertion passing regardless of what MCP returned.
    const mcpSide = m.mcpTerminal;
    const identical = JSON.stringify(m.restEnvelope) === JSON.stringify(mcpSide);
    const parity = m.restStatus === 200 && mcpSide != null && identical;
    out.push(C('mcp-rest-parity', parity ? 'PASS' : 'FAIL',
      `restStatus=${m.restStatus} mcpGet=${mcpSide ? 'present' : 'MISSING'} identical=${identical}`));

    // Caller attribution over MCP (6.2.0). The handshake sends clientInfo
    // name='full-smoke', which is NOT in the allowlist, so resolution must fall
    // through to the declared X-MMA-Client header. `mcp` here means the fallback
    // chain collapsed to the anonymous value, which is what made Agent Plugins
    // adoption unmeasurable — and adoption data is what decides whether the
    // per-client registration writers can be retired.
    const mcpClients = [...new Set(
      (q?.records ?? []).flatMap((x) => (Array.isArray(x.events) ? x.events : [])).map((ev) => ev.client).filter(Boolean),
    )];
    out.push(C('mcp-client-attribution',
      mcpClients.length === 0 ? 'NA' : (mcpClients.every((c) => c === SMOKE_CLIENT) ? 'PASS' : 'FAIL'),
      `client=[${mcpClients.join(', ')}] want=${SMOKE_CLIENT} (clientInfo='full-smoke' is unlisted, so the declared header must win)`));
    return out;
  }

  // ─── Async-error tasks (F5): a task that fails AFTER the 202 (e.g. an unresolvable
  //     target path) must return the SAME 6-field envelope as any terminal result,
  //     with the failure in `error` — not a bare { code, message } callers can't detect
  //     via env.error. ───
  if (e.kind === 'async_error') {
    const keys = Object.keys(r ?? {}).sort();
    const shapeOk = JSON.stringify(keys) === JSON.stringify(['error', 'execution', 'metrics', 'output', 'raw']);
    out.push(C('layered-200', shapeOk ? 'PASS' : 'FAIL', `keys=${keys.join(',')}`));
    const err = r?.error;
    const errOk = err && typeof err.code === 'string' && typeof err.message === 'string';
    out.push(C('async-error-envelope', errOk ? 'PASS' : 'FAIL', `error=${JSON.stringify(err)}`));
    out.push(C('async-error-status', r?.execution?.status === 'failed' ? 'PASS' : 'FAIL', `status=${r?.execution?.status}`));
    return out;
  }

  // New layered response: { task, output, execution, metrics, raw, error }
  const taskStatus = r?.execution?.status;
  const implSessionId = r?.execution?.sessions?.implementer;
  const revSessionId = r?.execution?.sessions?.reviewer;

  // ① response — did the task complete? A non-null error is the ONLY failure signal.
  //    done and done_with_concerns both carry error:null (a reviewer that couldn't emit
  //    parseable output is a concern surfaced in output.reviewerNote, NOT a fatal error —
  //    the implementer answer still stands in output.summary).
  const responseStatus = r?.error === null ? 'PASS' : 'FAIL';
  out.push(C('response', responseStatus, JSON.stringify(r?.error)));

  // ①b reviewer-degrade — whenever a real reviewer flakes on output format, the task must
  //    degrade gracefully rather than hard-fail. This invariant fires only when it actually
  //    happens (reviewerNote non-null), so it captures the haiku-writes-prose scenario in a
  //    live run without needing to force it. Contract when the reviewer was unavailable:
  //      • error is null (not fatal)          • status is done_with_concerns
  //      • output.summary carries a non-empty implementer answer (not the reviewer garbage)
  //      • reviewerNote.code === 'reviewer_unavailable'
  if (e.kind === 'read' || e.kind === 'write') {
    const note = r?.output?.reviewerNote ?? null;
    if (note !== null) {
      const summary = r?.output?.summary;
      const summaryLen = typeof summary === 'string'
        ? summary.length
        : (summary && typeof summary === 'object' ? JSON.stringify(summary).length : 0);
      const degradeOk =
        r?.error === null &&
        taskStatus === 'done_with_concerns' &&
        note.code === 'reviewer_unavailable' &&
        summaryLen > 2; // non-empty object/string — implementer answer survived
      out.push(C('reviewer-degrade', degradeOk ? 'PASS' : 'FAIL',
        `reviewer unavailable → error=${JSON.stringify(r?.error)} status=${taskStatus} noteCode=${note.code} summaryLen=${summaryLen}`));
    }
  }

  // ② sessions — validate session shape on the execution layer
  if (e.kind === 'read' || e.kind === 'write') {
    const hasImplSession = typeof implSessionId === 'string' && implSessionId.length > 0;
    out.push(C('sessions', hasImplSession ? 'PASS' : 'FAIL',
      `implementer={sessionId:${implSessionId?.slice(0, 12)}...}`));
  }

  // ③ tier — the new response does not carry tier on the session; tier is a
  // request-side concept validated by the scenario config. We still check that
  // the implementer session exists (validated above). If we had tier in metrics
  // we could check it here; for now this is a no-op when e.tier is set.
  // (The old contract embedded tier on sessions.implementer.tier; the new one
  // does not. Skip the tier check — it's enforced at dispatch time by the server.)

  // ④ review — reviewer session present when reviewed, absent when none
  if (e.kind === 'write') {
    if (e.reviewPolicy === 'none') {
      const skipped = revSessionId == null;
      out.push(C('review', skipped ? 'PASS' : 'FAIL',
        `reviewPolicy=none; reviewer=${revSessionId}`));
    } else if (e.type === 'journal_record') {
      // journal_record is deterministic decide-then-apply: the reviewer runs only when the
      // apply's invariants don't pass. A clean apply legitimately skips the reviewer, so a null
      // reviewer is correct here — either presence or absence is acceptable.
      out.push(C('review', 'PASS',
        `journal_record: reviewer optional (deterministic apply); reviewer=${revSessionId}`));
    } else {
      const hasReviewer = revSessionId != null && typeof revSessionId === 'string';
      out.push(C('review', hasReviewer ? 'PASS' : 'FAIL',
        `reviewer=${revSessionId}`));
    }
  }

  // Write-type specific checks
  if (e.kind === 'write') {
    const st = taskStatus;
    const ok = st === 'done' || st === 'done_with_concerns';
    const soft = e.reviewPolicy === 'none';
    out.push(C('terminal-status', ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'),
      `status=${st}${!ok && soft ? ' (no-guarantor -> soft)' : ''}`));

    // `execution.worktree` is a structurally-required response key whose value is now
    // permanently null — the engine owns no worktrees. Asserting null on EVERY route (not just
    // non-git ones) is what catches a regression that reintroduces engine-side worktrees.
    const wt = r?.execution?.worktree;
    out.push(C('worktree-null', wt === null ? 'PASS' : 'FAIL',
      wt === null ? 'execution.worktree null (engine owns no worktrees)' : `expected null, got ${JSON.stringify(wt)}`));

    // FR-4 — dirty-tree disclosure. Always present and boolean, so a caller can read it
    // unconditionally; true exactly when the fixture left the tree dirty at dispatch.
    const dirty = r?.execution?.dirtyAtDispatch;
    if (typeof dirty !== 'boolean') {
      out.push(C('dirty-at-dispatch', 'FAIL', `execution.dirtyAtDispatch must be a boolean, got ${JSON.stringify(dirty)}`));
    } else if (e.dirtyRepo) {
      out.push(C('dirty-at-dispatch', dirty === true ? 'PASS' : 'FAIL',
        `fixture dispatched a dirty tree → expect true, got ${dirty}`));
    } else if (e.nonGitCwd) {
      out.push(C('dirty-at-dispatch', dirty === false ? 'PASS' : 'FAIL',
        `non-git target has no dirty state → expect false, got ${dirty}`));
    } else {
      out.push(C('dirty-at-dispatch', 'PASS', `boolean (${dirty})`));
    }
  }

  // Read-type specific checks
  if (e.kind === 'read') {
    if (e.type === 'research') {
      // These were two hardcoded PASSes whose own notes admitted they checked nothing
      // ("validated server-side"). `sourcesUsed` did leave the envelope, but the research refiner
      // schema still requires `url` and `source` on every finding — that IS the adapter surface
      // reaching the caller, and it is observable right here.
      const researchFindings = r?.output?.summary?.findings ?? [];
      const sourced = researchFindings.filter((f) => typeof f?.url === 'string' && f.url.length > 0
        && typeof f?.source === 'string' && f.source.length > 0);
      out.push(C('research-sources', researchFindings.length > 0 && sourced.length === researchFindings.length ? 'PASS' : 'FAIL',
        `${sourced.length}/${researchFindings.length} findings carry both url and source`));
      const distinctSources = new Set(sourced.map((f) => f.source));
      out.push(C('research-adapter-surface', distinctSources.size > 0 ? 'PASS' : 'FAIL',
        `sources reaching the caller: ${[...distinctSources].join(', ') || 'NONE'}`));
    }
  }

  // ⑤ quality — does the output contain meaningful, type-appropriate content?
  if (e.kind === 'read' || e.kind === 'write') {
    const [qStatus, qDetail] = checkQuality(e.type, e.subtype, r, e.subsetComponents);
    out.push(C('quality', qStatus, qDetail));
  }

  // ⑤b pipeline-collaboration — did the reviewer receive implementer output?
  //    The two-phase pipeline should produce non-empty implementer output AND
  //    non-empty reviewer output. If either is empty, the collaborative pipeline
  //    is broken (reviewer rubber-stamped or implementer produced nothing).
  //    journal_record is exempt: its reviewer runs only on an invariant failure (deterministic
  //    decide-then-apply), so a clean apply has no reviewer output by design.
  if ((e.kind === 'read' || e.kind === 'write') && e.reviewPolicy !== 'none' && e.type !== 'orchestrate' && e.type !== 'journal_record') {
    const rawImpl = r?.raw?.implementer ?? '';
    const rawRev = r?.raw?.reviewer ?? '';
    const implLen = typeof rawImpl === 'string' ? rawImpl.length : 0;
    const revLen = typeof rawRev === 'string' ? rawRev.length : 0;
    // The check catches a BROKEN pipeline (an empty side), not terse-but-valid output.
    // A correct delegate/execute_plan can legitimately return a compact JSON block (~20–40
    // chars), so the bar is "non-empty", not "long": both sides must clear a small floor.
    const bothPresent = implLen > 10 && revLen > 10;
    out.push(C('pipeline-collaboration', bothPresent ? 'PASS' : 'FAIL',
      `implementer=${implLen}chars reviewer=${revLen}chars — both must be non-empty`));
  }

  // ⑥ contextBlockId
  if (e.kind === 'read' || e.kind === 'write') {
    const cb = r?.output?.contextBlockId;
    if (e.kind === 'read') {
      const ok = typeof cb === 'string' && cb.length > 0;
      out.push(C('context-block', ok ? 'PASS' : (e.type === 'research' ? 'WARN' : 'FAIL'),
        `contextBlockId=${cb} (read route -> expect non-null id)`));
    } else {
      out.push(C('context-block', cb === null ? 'PASS' : 'FAIL',
        `contextBlockId=${cb} (write route -> expect exactly null; undefined = not projected)`));
    }
  }

  // ⑦ cost
  if (e.kind === 'read' || e.kind === 'write') {
    const implCost = r?.metrics?.implementer?.costUsd;
    const hasCost = typeof implCost === 'number' && implCost > 0;
    out.push(C('cost', hasCost ? 'PASS' : 'FAIL',
      `implementer.costUsd=${implCost}`));
  }

  // Session reuse check
  if (e.sessionReuse && rec.resumeSessionId) {
    const actualId = implSessionId;
    out.push(C('session-reuse', actualId === rec.resumeSessionId ? 'PASS' : 'FAIL',
      `requested=${rec.resumeSessionId?.slice(0, 12)}... got=${actualId?.slice(0, 12)}...`));
  }

  // ⑧ diagnostics
  if (d && d.events.length) {
    const kinds = [...new Set(d.events.map((x) => x.kind))];
    const terminal = kinds.includes('batch_completed') || kinds.includes('batch_failed');
    out.push(C('diag-events', kinds.includes('batch_created') && terminal ? 'PASS' : 'FAIL', `kinds=${kinds}`));
  } else {
    out.push(C('diag-events', 'WARN', 'no diagnostics events found for task'));
  }

  // ⑨ Sandbox confinement (scenarios #20-22)
  if (e.sandbox) {
    const output = r?.raw?.implementer ?? (typeof r?.output?.summary === 'string' ? r.output.summary : '') ?? '';

    // These two checks used to read `<adapted> || taskStatus === 'done'`. Every scenario reaches a
    // terminal status, so the `||` made them pass unconditionally: the checks guarding sandbox
    // confinement never evaluated confinement at all. They now assert the only thing that actually
    // settles it — whether the escape file exists on disk. `dispatch.mjs` removes each target
    // before the run, so absence here is evidence rather than luck, and an escape is a hard FAIL
    // rather than a WARN, because a worker outside its cwd is the failure the sandbox exists for.
    if (e.sandbox === 'cwd-only' && (e.id === 20 || e.id === 21)) {
      const escapeTarget = SANDBOX_ESCAPE_TARGETS[e.id];
      const escaped = escapeTarget ? existsSync(escapeTarget) : false;
      const checkId = e.id === 20 ? 'sandbox-cwd-escape' : 'sandbox-cd-chain';
      out.push(C(checkId, escaped ? 'FAIL' : 'PASS',
        escaped
          ? `WORKER ESCAPED ITS CWD: ${escapeTarget} exists after the run`
          : `${escapeTarget} absent — confinement held; status=${taskStatus}`));
      // The positive half: the worker adapted and wrote inside its cwd. Weaker than the absence
      // assertion above, so a WARN — a worker that gives up entirely is worth noticing, but it is
      // not a confinement breach.
      const adapted = e.id === 20
        ? /confined|CONFINED/.test(output)
        : /cd.safe|CD_SAFE/.test(output);
      out.push(C(`${checkId}-adapted`, adapted ? 'PASS' : 'WARN',
        `worker ${adapted ? 'adapted and wrote in-cwd' : 'did not report an in-cwd write'}; status=${taskStatus}`));
    }

    if (e.sandbox === 'read-only') {
      // Read-only task should complete normally without any write capability.
      out.push(C('sandbox-readonly', taskStatus === 'done' || taskStatus === 'done_with_concerns' ? 'PASS' : 'FAIL',
        `read-only sandbox task status=${taskStatus}`));
    }
  }

  // ⑩ Layered 200 shape — top-level keys must be exactly the 6 categories
  if (e.kind === 'read' || e.kind === 'write') {
    const keys = Object.keys(r ?? {}).sort();
    const expected = ['error', 'execution', 'metrics', 'output', 'raw'];
    const match = JSON.stringify(keys) === JSON.stringify(expected);
    out.push(C('layered-200', match ? 'PASS' : 'FAIL',
      `keys=${keys.join(',')} expected=${expected.join(',')}`));
  }

  // ⑪ Token usage — metrics must include per-phase usage + totalUsage
  if (e.kind === 'read' || e.kind === 'write') {
    const m = r?.metrics ?? {};
    const hasImplUsage = m.implementer?.usage?.inputTokens !== undefined;
    const hasTotalUsage = m.totalUsage?.inputTokens !== undefined;
    out.push(C('token-usage', hasImplUsage && hasTotalUsage ? 'PASS' : 'FAIL',
      `implementer.usage=${hasImplUsage} totalUsage=${hasTotalUsage}`));
  }

  // ⑫ Structured 202 polling shape (captured during poll phase)
  if (rec.polling202) {
    const p = rec.polling202;
    const hasFields = p.executionId && p.status === 'running' && p.phase && typeof p.elapsedMs === 'number' && p.startedAt;
    out.push(C('structured-202', hasFields ? 'PASS' : 'FAIL',
      `phase=${p.phase} elapsedMs=${p.elapsedMs} startedAt=${p.startedAt}`));

    // ⑫b A running task must say WHAT it is, not just how far along it is. A poll
    //     used to answer with a phase name that reads identically for a spec, a
    //     review and an investigation, while the type had been known since
    //     admission. `phaseElapsedMs` is asserted here too because it is the field
    //     that silently went missing on one wire when the two running-snapshot
    //     shapes were maintained by hand.
    const identity = p.executionId && typeof p.type === 'string' && p.type.length > 0 && typeof p.cwd === 'string' && p.cwd.length > 0;
    out.push(C('running-identity', identity && typeof p.phaseElapsedMs === 'number' ? 'PASS' : 'FAIL',
      `type=${p.type} cwd=${p.cwd ? 'set' : 'missing'} phaseElapsedMs=${p.phaseElapsedMs}`));
  }

  // ⑫d Activity history (6.1.0). The daemon buckets the run's recorded timestamps at
  //     READ time, so every viewer sees the same shape no matter when they opened the
  //     panel. Asserted on the LAST running snapshot: the first one frequently lands
  //     before the worker has emitted anything, and `activity` is correctly omitted
  //     when there is nothing to draw.
  //
  //     `phases` monotonicity is the load-bearing part. It encodes an engine fact —
  //     a run never returns to implementing once review begins — so a quiet bucket
  //     after the handover belongs to the review. Derived per-bucket from raw samples
  //     alone, that invariant would break exactly where the panel is least readable.
  if (rec.polling202Last) {
    const p = rec.polling202Last;
    const counts = p.activity;
    const phases = p.activityPhases;
    if (counts === undefined && phases === undefined) {
      out.push(C('activity-series', 'NA', 'no provider events recorded before the terminal read'));
    } else {
      const BUCKETS = 34;
      const shaped = Array.isArray(counts) && counts.length === BUCKETS
        && counts.every((n) => Number.isInteger(n) && n >= 0)
        && Array.isArray(phases) && phases.length === BUCKETS
        && phases.every((x) => x === 1 || x === 2);
      const monotonic = shaped && phases.every((x, i) => i === 0 || x >= phases[i - 1]);
      const observed = shaped && counts.reduce((a, b) => a + b, 0) > 0;
      out.push(C('activity-series', shaped && monotonic && observed ? 'PASS' : 'FAIL',
        `counts=${Array.isArray(counts) ? counts.length : typeof counts} phases=${Array.isArray(phases) ? phases.length : typeof phases} `
        + `samples=${Array.isArray(counts) ? counts.reduce((a, b) => a + b, 0) : 'n/a'} monotonic=${monotonic}`));
    }
  }

  // ⑫c Identity is the SAME across admission, every poll, and the terminal
  //     envelope. Three surfaces, one answer — an agent reading back through a
  //     transcript finds the handle where it was returned, not where the task was
  //     submitted, so a disagreement between them is a real defect rather than a
  //     cosmetic one. Only the live daemon can prove this; a unit test asserts a
  //     shared helper, not that both wires actually call it.
  if (rec.admission && r?.execution?.executionId) {
    const a = rec.admission;
    const p = rec.polling202;
    // `executionId` and `type` must be PRESENT on admission and on the terminal
    // envelope, not merely non-contradictory: an absent field agrees with
    // everything, which is exactly how a surface that silently stopped
    // reporting identity would slip through a pure equality check.
    const agree = (field, required) => {
      const surfaces = [['admit', a[field]], ['final', r.execution[field]]];
      if (p) surfaces.push(['poll', p[field]]);
      const present = surfaces.filter(([, v]) => v !== undefined);
      if (required && present.length !== surfaces.length) return false;
      return present.every(([, v]) => v === present[0][1]);
    };
    const mismatched = [['executionId', true], ['type', true], ['subtype', false]]
      .filter(([f, required]) => !agree(f, required))
      .map(([f]) => f);
    out.push(C('identity-consistency', mismatched.length === 0 ? 'PASS' : 'FAIL',
      mismatched.length === 0
        ? `executionId/type${e.subtype ? '/subtype' : ''} present and equal across admission, poll, terminal`
        : `disagree or missing: ${mismatched.map((f) => `${f}(admit=${a[f]} poll=${p?.[f]} final=${r.execution[f]})`).join(', ')}`));
  }

  // ⑬ Audit findings: weight field + evidence section prefix
  if (e.type === 'audit' && (e.kind === 'read')) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    if (findings.length > 0) {
      const allHaveWeight = findings.every(f => ['critical', 'high', 'medium', 'low'].includes(f.weight));
      out.push(C('weight-field', allHaveWeight ? 'PASS' : 'FAIL',
        `${findings.length} findings, all have valid weight=${allHaveWeight}`));

      // Grounding convention: every evidence string starts with its source in square brackets —
      // a markdown heading for document audits (`[### Heading]`) or a file/path ref for code audits
      // (`[src/math.ts]` or `[src/math.ts:3]`, since code has no headings). Accept any bracketed
      // source prefix; what matters is that the finding names where the evidence lives.
      const withPrefix = findings.filter(f => /^\[[^\]]+\]\s/.test(f.evidence ?? ''));
      out.push(C('evidence-prefix', withPrefix.length > 0 ? 'PASS' : 'WARN',
        `${withPrefix.length}/${findings.length} findings have a [source] evidence prefix`));
    }
  }

  // ⑭ Audit subtype in task identity
  if (e.type === 'audit' && e.subtype) {
    const actualSubtype = r?.execution?.subtype;
    out.push(C('subtype', actualSubtype === e.subtype ? 'PASS' : 'FAIL',
      `expected=${e.subtype} got=${actualSubtype}`));
  }

  // ⑮ Write route filesChanged — must be populated (from git diff or tool tracking).
  // Non-git (in-place) targets have no git diff to compute changed files from, so the
  // git-diff-based filesChanged is not asserted there.
  if (e.kind === 'write' && e.reviewPolicy !== 'none' && !e.nonGitCwd && !e.noopWrite && e.type !== 'journal_record') {
    const fc = r?.output?.filesChanged;
    const hasFiles = Array.isArray(fc) && fc.length > 0;
    out.push(C('files-changed', hasFiles ? 'PASS' : 'WARN',
      `filesChanged=${Array.isArray(fc) ? fc.length : 'missing'} files`));
  }

  // ⑮b journal_record batch completeness — a records[] batch must produce exactly
  //     one outcome per submitted record: recorded[]+failed[] === submitted count.
  if (e.batchRecords) {
    const summary = r?.output?.summary;
    const recorded = Array.isArray(summary?.recorded) ? summary.recorded.length : 0;
    const failed = Array.isArray(summary?.failed) ? summary.failed.length : 0;
    out.push(C('batch-completeness', recorded + failed === e.batchRecords ? 'PASS' : 'FAIL',
      `recorded=${recorded} failed=${failed} submitted=${e.batchRecords} (records[] processed sequentially)`));
  }

  // ⑯ Delta mode — verify that round 2 audit (with contextBlockId) still produces findings
  if (e.delta) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    // `findings.length >= 0` is true for every possible array, so this reported PASS even if the
    // worker never received the prior context block or returned nothing at all. The stated intent
    // is that round 2 STILL produces findings, so assert the shape hard and the intent as a warn.
    out.push(C('delta-mode', Array.isArray(findings) ? 'PASS' : 'FAIL',
      `delta round 2 returned ${Array.isArray(findings) ? `${findings.length} findings` : 'a non-array summary'}`));
    out.push(C('delta-still-finds', findings.length > 0 ? 'PASS' : 'WARN',
      `${findings.length} findings with the prior round injected as context`));
  }

  // ⑰ Spec components — default spec emits all 8 (Forge-compat); a subset request must
  //    emit EXACTLY the requested components, reordered to canonical order.
  if (e.type === 'spec') {
    const specSummary = r?.output?.summary;
    const sections = specSummary?.sections ?? [];
    if (e.subsetComponents) {
      // Expected = the requested labels in canonical order (regardless of request order).
      const want = CANON.filter(c => e.subsetComponents.includes(c));
      const exact = sections.length === want.length && want.every((c, i) => sections[i] === c);
      out.push(C('subset-components', exact ? 'PASS' : 'FAIL',
        `requested=${JSON.stringify(e.subsetComponents)} expected-canonical=${JSON.stringify(want)} got=${JSON.stringify(sections)}`));
    } else {
      const missing = CANON.filter(c => !sections.includes(c));
      out.push(C('forge-compat', missing.length === 0 ? 'PASS' : 'WARN',
        `sections=${JSON.stringify(sections)}${missing.length > 0 ? ` missing=[${missing.join(',')}]` : ''}`));
    }
    if (e.groundingFile) {
      // Two target files (decisions [authoritative] + exploration.md [grounding]) must
      // still produce a full 8-component spec — proving the multi-file dispatch works and
      // the worker expanded the decisions, not the exploration's unresolved rough options.
      out.push(C('two-file-grounding', sections.length === 8 ? 'PASS' : 'FAIL',
        `2 target files → sections=${JSON.stringify(sections)}`));
    }
  }

  // ⑱ Non-git cwd — the route edits the folder in place and the engine makes NO commit, so
  //    there is no git evidence to derive: filesChanged falls back to the provider's list.
  if (e.nonGitCwd) {
    const wt = r?.execution?.worktree;
    const dirty = r?.execution?.dirtyAtDispatch;
    out.push(C('non-git-cwd', wt === null && dirty === false ? 'PASS' : 'FAIL',
      `worktree=${JSON.stringify(wt)} (expect null), dirtyAtDispatch=${dirty} (expect false — a non-git dir has no dirty state)`));
  }

  // Queue (per-dispatch, best-effort)
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `records=${q?.records?.length ?? 0}`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    // A MISSING schemaVersion is a FAIL, not a PASS. `sv === undefined || …` excused exactly the
    // failure this check exists to catch — an envelope reaching the queue with no version on it at
    // all — and it is the same trap the comment below describes for attribution: "a check that
    // never runs looks exactly like a check that always passes".
    out.push(C('schema-version', sv === SCHEMA_VERSION ? 'PASS' : 'FAIL', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
    // Caller attribution must survive the whole path: header -> resolveCallerIdentity
    // -> wire event. It is how "which clients still use the bespoke writers?" gets
    // answered, so a silent collapse to `other` would quietly make that
    // unanswerable — and `other` is exactly what a broken allowlist produces.
    // A queue line is an ENVELOPE ({installId, schemaVersion, events: [...]}); the
    // attribution lives on each event, not the envelope. Reading it off the wrong
    // level yields undefined everywhere, which would report NA forever — a check
    // that never runs looks exactly like a check that always passes.
    // The queue is sampled by LINE-COUNT WINDOW, and a wire event carries `eventId`, `route` and
    // `client` but deliberately NO task id — telemetry is not task-correlated. So this sample
    // cannot separate the harness's own events from those of any other client using the same
    // daemon during the window. That distinction changes what a non-matching client MEANS:
    //
    //   - no SMOKE_CLIENT event at all  → FAIL. Attribution genuinely did not survive the path,
    //     which is the defect this check exists for (a silent collapse to `other`).
    //   - SMOKE_CLIENT present, plus a foreign client → the sample is CONTAMINATED. The harness
    //     cannot tell a collapsed event of its own from a legitimate event of the other client,
    //     so it has not learned whether attribution held. Report that as unsettled, not as a
    //     defect: "another client shared this daemon" and "attribution is broken" are different
    //     facts, and reporting the first as the second sends a reader hunting a bug that is not
    //     there. This cost a full 50-scenario run on 2026-08-09.
    //   - only SMOKE_CLIENT → PASS.
    const clients = [...new Set(
      q.records.flatMap((r) => (Array.isArray(r.events) ? r.events : [])).map((e) => e.client).filter(Boolean),
    )];
    const foreign = clients.filter((c) => c !== SMOKE_CLIENT);
    const mineSeen = clients.includes(SMOKE_CLIENT);
    const status = clients.length === 0 ? 'NA'
      : !mineSeen ? 'FAIL'
        : foreign.length > 0 ? 'WARN'
          : 'PASS';
    out.push(C('client-attribution', status,
      status === 'WARN'
        ? `UNSETTLED — another client shared this daemon during the window: foreign=[${foreign.join(', ')}]. `
          + `smoke:full needs exclusive use of the daemon; re-run with nothing else dispatching to it.`
        : `client=[${clients.join(', ')}] want=${SMOKE_CLIENT}`));

    // The cost baseline must be the CONFIGURED main tier on every event. The
    // defect this replaces: with no per-call model claim, the runtime fell back
    // to `agents[implTier].model` — one of the two workers that had just run the
    // task — so `mainCostUSD` compared a run against itself and reported a
    // negative saving for runs that saved money. Two separate assertions,
    // because they fail differently: equality catches a wrong source, and the
    // worker-tier exclusion catches a fallback that happens to look plausible.
    const wantMain = configuredMainModel();
    const workerModels = configuredWorkerModels().filter((m) => m !== wantMain);
    const mainModels = [...new Set(
      q.records.flatMap((r) => (Array.isArray(r.events) ? r.events : [])).map((e) => e.mainModel).filter(Boolean),
    )];
    out.push(C('main-model-baseline',
      wantMain === null ? 'NA'
        : mainModels.length === 0 ? 'FAIL'
          : (mainModels.every((m) => m === wantMain) ? 'PASS' : 'FAIL'),
      `mainModel=[${mainModels.join(', ')}] want=${wantMain ?? '(no agents.main in config)'}`));
    out.push(C('baseline-is-not-a-worker-tier',
      workerModels.length === 0 || mainModels.length === 0 ? 'NA'
        : (mainModels.some((m) => workerModels.includes(m)) ? 'FAIL' : 'PASS'),
      `mainModel=[${mainModels.join(', ')}] workerTiers=[${workerModels.join(', ')}]`));
  }

  // ─── Deliverable-agnostic lifecycle (#44, #45, #46) ───

  // #44 — a digest-matched ApprovedContract must be ACCEPTED, not merely well-formed.
  // Acceptance is only proven by a task that reached a terminal envelope: a contract rejected
  // at either validation layer never gets a taskId at all, and a rejection AFTER admission
  // would surface as a terminal `error`. Both failure modes are covered by asserting the
  // terminal envelope carries no error.
  if (e.deliverableContract) {
    const terminal = typeof r?.execution?.status === 'string';
    out.push(C('contract-accepted', terminal && !r?.error ? 'PASS' : 'FAIL',
      `status=${r?.execution?.status} error=${JSON.stringify(r?.error)}`));
    // The contract governs the work; it must not leak into the task identity. `deliverable`
    // is an input, and echoing it back would make an approval look like task state.
    out.push(C('contract-not-echoed-as-identity',
      r?.execution?.deliverable === undefined ? 'PASS' : 'FAIL',
      `task.deliverable=${JSON.stringify(r?.execution?.deliverable)}`));
  }

  // #45 — a Contract Task with NO declared check must parse, run, and commit.
  // The precise regression this guards: the previous grammar raised `malformed-plan` before
  // any worker started whenever `Test:` was absent, so the task failed terminally. Asserting
  // "not malformed-plan" is therefore the load-bearing half; the declared output landing in
  // the engine-measured commit proves the run was real rather than an empty success.
  if (e.noCheckPlan) {
    const code = r?.error?.code ?? null;
    out.push(C('no-check-plan-parsed', code !== 'malformed-plan' && code !== 'unsupported-legacy-plan'
      ? 'PASS' : 'FAIL', `errorCode=${code}`));
    const files = r?.output?.filesChanged ?? [];
    out.push(C('no-check-output-committed',
      files.some((f) => String(f).endsWith('docs/release-note.md')) ? 'PASS' : 'FAIL',
      `filesChanged=${JSON.stringify(files)}`));
    // A task with no declared check must still reach a real terminal status rather than being
    // reported done with nothing scored.
    out.push(C('no-check-terminal-status',
      ['done', 'done_with_concerns'].includes(r?.execution?.status) ? 'PASS' : 'FAIL',
      `status=${r?.execution?.status}`));
  }

  // #46 — `method` must survive the wire and reach Method resolution (SPEC-005 Method Registry).
  // `task.method` on the terminal envelope is the only caller-visible evidence that the
  // field was honoured rather than dropped: `resolveMethod()` receives the same identifier, so
  // an echoed value and injected committed guidance succeed or fail together.
  if (e.method) {
    out.push(C('method-echoed', r?.execution?.method === e.method ? 'PASS' : 'FAIL',
      `execution.method=${r?.execution?.method} want=${e.method}`));
    // `method` and `subtype` answer different questions and must never both appear.
    out.push(C('method-not-confused-with-subtype', r?.execution?.subtype === undefined ? 'PASS' : 'FAIL',
      `task.subtype=${r?.execution?.subtype}`));
  }

  return out;
}
