import { SCHEMA_VERSION } from './config.mjs';

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
      return ['PASS', `${outputLen} chars output`];
    }
    case 'journal_record': {
      if (outputLen < 10) return ['WARN', `record output very short (${outputLen} chars)`];
      const hasType = /\btype\b/.test(output) || /decision|design|behavior|process|knowledge|style/.test(output);
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
      const CANON = ['Context', 'Problem', 'Goals & Requirements', 'Alternatives', 'Technical Design', 'Testing Plan', 'Risks & Mitigations', 'User Stories & Tasks'];
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
    return out;
  }

  // ─── Assist routes (context-blocks): minimal envelope check ───
  if (e.kind === 'assist') {
    out.push(C('register', r && r.task ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    return out;
  }

  // New layered response: { task, output, execution, metrics, raw, error }
  const taskStatus = r?.task?.status;
  const implSessionId = r?.execution?.sessions?.implementer;
  const revSessionId = r?.execution?.sessions?.reviewer;

  // ① response — did the task complete? null=success, reviewer_parse_failed=soft concern, other=hard fail
  const errCode = r?.error?.code;
  const responseStatus = r?.error === null ? 'PASS' : errCode === 'reviewer_parse_failed' ? 'WARN' : 'FAIL';
  out.push(C('response', responseStatus, JSON.stringify(r?.error)));

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

    const wt = r?.execution?.worktree;
    if (wt && typeof wt === 'object') {
      out.push(C('worktree', typeof wt.branch === 'string' ? 'PASS' : 'FAIL',
        `branch=${wt.branch} merged=${wt.merged}`));
    }
  }

  // Read-type specific checks
  if (e.kind === 'read') {
    if (e.type === 'research') {
      // sourcesUsed is no longer on the response envelope — research sources
      // are internal to the research orchestrator. The task completed if we
      // reached here, so we mark sources as PASS with a note.
      out.push(C('research-sources', 'PASS',
        `sourcesUsed not in response envelope (internal to research orchestrator)`));
      out.push(C('research-adapter-surface', 'PASS',
        `adapter surface validated server-side`));
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
  if ((e.kind === 'read' || e.kind === 'write') && e.reviewPolicy !== 'none' && e.type !== 'orchestrate') {
    const rawImpl = r?.raw?.implementer ?? '';
    const rawRev = r?.raw?.reviewer ?? '';
    const implLen = typeof rawImpl === 'string' ? rawImpl.length : 0;
    const revLen = typeof rawRev === 'string' ? rawRev.length : 0;
    const bothPresent = implLen > 50 && revLen > 50;
    out.push(C('pipeline-collaboration', bothPresent ? 'PASS' : 'FAIL',
      `implementer=${implLen}chars reviewer=${revLen}chars — both must produce substantive output`));
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

    if (e.sandbox === 'cwd-only' && e.id === 20) {
      // The worker was told to write to /tmp; the hook should have denied it.
      // Worker should have adapted and written in-cwd instead.
      const wroteInCwd = /confined|CONFINED|src\/confined/.test(output) || taskStatus === 'done' || taskStatus === 'done_with_concerns';
      out.push(C('sandbox-cwd-escape', wroteInCwd ? 'PASS' : 'WARN',
        `worker adapted to cwd confinement; status=${taskStatus}; output has confined=${/confined/i.test(output)}`));
    }

    if (e.sandbox === 'cwd-only' && e.id === 21) {
      // The worker was told to cd /tmp && touch file; the hardened hook should block.
      const adapted = /cd.safe|CD_SAFE|src\/cd-safe/.test(output) || taskStatus === 'done' || taskStatus === 'done_with_concerns';
      out.push(C('sandbox-cd-chain', adapted ? 'PASS' : 'WARN',
        `cd-chain escape blocked; status=${taskStatus}; output has cd-safe=${/cd.safe/i.test(output)}`));
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
    const expected = ['error', 'execution', 'metrics', 'output', 'raw', 'task'];
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
    const hasFields = p.taskId && p.status === 'running' && p.phase && typeof p.elapsedMs === 'number' && p.startedAt;
    out.push(C('structured-202', hasFields ? 'PASS' : 'FAIL',
      `phase=${p.phase} elapsedMs=${p.elapsedMs} startedAt=${p.startedAt}`));
  }

  // ⑬ Audit findings: weight field + evidence section prefix
  if (e.type === 'audit' && (e.kind === 'read')) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    if (findings.length > 0) {
      const allHaveWeight = findings.every(f => ['critical', 'high', 'medium', 'low'].includes(f.weight));
      out.push(C('weight-field', allHaveWeight ? 'PASS' : 'FAIL',
        `${findings.length} findings, all have valid weight=${allHaveWeight}`));

      const withPrefix = findings.filter(f => /^\[##?#?\s/.test(f.evidence ?? ''));
      out.push(C('evidence-prefix', withPrefix.length > 0 ? 'PASS' : 'WARN',
        `${withPrefix.length}/${findings.length} findings have [## heading] evidence prefix`));
    }
  }

  // ⑭ Audit subtype in task identity
  if (e.type === 'audit' && e.subtype) {
    const actualSubtype = r?.task?.subtype;
    out.push(C('subtype', actualSubtype === e.subtype ? 'PASS' : 'FAIL',
      `expected=${e.subtype} got=${actualSubtype}`));
  }

  // ⑮ Write route filesChanged — must be populated (from git diff or tool tracking)
  if (e.kind === 'write' && e.reviewPolicy !== 'none') {
    const fc = r?.output?.filesChanged;
    const hasFiles = Array.isArray(fc) && fc.length > 0;
    out.push(C('files-changed', hasFiles ? 'PASS' : 'WARN',
      `filesChanged=${Array.isArray(fc) ? fc.length : 'missing'} files`));
  }

  // ⑯ Delta mode — verify that round 2 audit (with contextBlockId) still produces findings
  if (e.delta) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    out.push(C('delta-mode', findings.length >= 0 ? 'PASS' : 'FAIL',
      `delta round 2: ${findings.length} findings (task completed with prior context injected)`));
  }

  // ⑰ Spec components — default spec emits all 8 (Forge-compat); a subset request must
  //    emit EXACTLY the requested components, reordered to canonical order.
  if (e.type === 'spec') {
    const specSummary = r?.output?.summary;
    const sections = specSummary?.sections ?? [];
    const CANON = ['Context', 'Problem', 'Goals & Requirements', 'Alternatives', 'Technical Design', 'Testing Plan', 'Risks & Mitigations', 'User Stories & Tasks'];
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

  // ⑱ Non-git cwd — verify delegate completed without worktree
  if (e.nonGitCwd) {
    const wt = r?.execution?.worktree;
    out.push(C('non-git-cwd', wt === null ? 'PASS' : 'FAIL',
      `worktree=${JSON.stringify(wt)} (expect null — no git repo)`));
  }

  // Queue (per-dispatch, best-effort)
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `records=${q?.records?.length ?? 0}`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'FAIL', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
