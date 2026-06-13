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
//   7. cost          — implementerUsd > 0?
//   8. diag-events   — expected diagnostic events present?
// ─────────────────────────────────────────────────────────────────────────────

// Quality assertions per task type. Returns [status, detail].
function checkQuality(type, subtype, task0, structuredReport) {
  const output = task0.implementerOutput ?? task0.output ?? '';
  const findings = structuredReport?.findings ?? task0.findings ?? [];
  const outputLen = typeof output === 'string' ? output.length : 0;

  switch (type) {
    case 'audit': {
      if (findings.length === 0) return ['FAIL', 'audit produced 0 findings — expected at least 1'];
      const withEvidence = findings.filter(f => f?.evidence?.length > 20);
      if (withEvidence.length === 0) return ['FAIL', `${findings.length} findings but none have evidence >20 chars`];
      const withSuggestion = findings.filter(f => f?.suggestion?.length > 0);
      return ['PASS', `${findings.length} findings, ${withEvidence.length} grounded, ${withSuggestion.length} with suggestions`];
    }
    case 'investigate': {
      if (outputLen < 100) return ['FAIL', `output too short (${outputLen} chars) — expected substantive analysis`];
      const citesFile = /\b\w+\.\w+:\d+\b|file:|line\s+\d+/i.test(output);
      return [citesFile ? 'PASS' : 'WARN', `${outputLen} chars; file-citation=${citesFile}`];
    }
    case 'review': {
      if (findings.length === 0 && outputLen < 50) return ['WARN', 'review produced 0 findings and minimal output'];
      return ['PASS', `${findings.length} findings, ${outputLen} chars output`];
    }
    case 'debug': {
      if (outputLen < 100) return ['FAIL', `debug output too short (${outputLen} chars) — expected root-cause trace`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'research': {
      if (outputLen < 200) return ['WARN', `research output short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output, ${findings.length} findings`];
    }
    case 'journal_recall': {
      if (outputLen < 20) return ['WARN', `recall output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'journal_record': {
      if (outputLen < 10) return ['WARN', `record output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'delegate': {
      if (outputLen < 20) return ['WARN', `delegate output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'execute_plan': {
      if (outputLen < 20) return ['WARN', `execute_plan output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'main': {
      if (outputLen < 50) return ['FAIL', `orchestrate output too short (${outputLen} chars) — expected structured response`];
      return ['PASS', `${outputLen} chars output`];
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
    out.push(C('register', r && (r.error?.kind === 'not_applicable' || r.results?.length) ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    return out;
  }

  const sr = r?.structuredReport ?? {};
  const task0 = r?.results?.[0] ?? {};

  // ① response — did the task complete?
  out.push(C('response', r?.error?.kind === 'not_applicable' ? 'PASS' : 'FAIL', JSON.stringify(r?.error)));

  // ② sessions — validate session shape on the task result
  const sessions = task0.sessions ?? {};
  const impl = sessions.implementer ?? {};
  if (e.kind === 'read' || e.kind === 'write') {
    const hasImplFields = typeof impl.tier === 'string'
      && typeof impl.sessionId === 'string' && impl.sessionId.length > 0
      && typeof impl.resumeSupported === 'boolean';
    out.push(C('sessions', hasImplFields ? 'PASS' : 'WARN',
      `implementer={tier:${impl.tier}, sessionId:${impl.sessionId?.slice(0, 12)}..., resume:${impl.resumeSupported}}`));
  }

  // ③ tier — does implementer tier match expectation?
  if (e.tier) {
    out.push(C('tier', impl.tier === e.tier ? 'PASS' : 'WARN',
      `expected=${e.tier} got=${impl.tier}`));
  }

  // ④ review — reviewer session present when reviewed, absent when none
  if (e.kind === 'write') {
    const reviewer = sessions.reviewer;
    if (e.reviewPolicy === 'none') {
      const skipped = reviewer == null || reviewer === null;
      out.push(C('review', skipped ? 'PASS' : 'FAIL',
        `reviewPolicy=none; reviewer=${JSON.stringify(reviewer)}`));
    } else {
      const hasReviewer = reviewer != null && typeof reviewer === 'object';
      out.push(C('review', hasReviewer ? 'PASS' : 'WARN',
        `reviewer=${JSON.stringify(reviewer)}`));
    }
  }

  // Write-type specific checks
  if (e.kind === 'write') {
    const st = task0.status;
    const ok = st === 'done' || st === 'done_with_concerns';
    const soft = e.reviewPolicy === 'none';
    out.push(C('terminal-status', ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'),
      `status=${st}${!ok && soft ? ' (no-guarantor -> soft)' : ''}`));

    const wt = task0.worktree;
    if (wt && typeof wt === 'object') {
      out.push(C('worktree', typeof wt.branch === 'string' ? 'PASS' : 'WARN',
        `branch=${wt.branch} hasChanges=${wt.hasChanges}`));
    }
  }

  // Read-type specific checks
  if (e.kind === 'read') {
    const findings = sr.findings ?? task0.findings ?? [];
    out.push(C('findings', Array.isArray(findings) ? 'PASS' : 'FAIL', `n=${findings.length}`));

    if (e.type === 'research') {
      const withEvidence = findings.some((f) => typeof f?.evidence === 'string' && f.evidence.trim().length > 0);
      const evidenceVerdict = findings.length === 0 ? 'WARN' : (withEvidence ? 'PASS' : 'FAIL');
      out.push(C('research-evidence', evidenceVerdict,
        findings.length === 0
          ? 'worker synthesized 0 findings (empty != failure per contract; sources were fetched)'
          : `findings=${findings.length}; ${findings.filter((f) => f?.evidence?.trim()).length} carry evidence`));

      const sourcesUsed = sr.sourcesUsed ?? task0.sourcesUsed ?? [];
      const used = Array.isArray(sourcesUsed) ? sourcesUsed.filter((s) => s?.used === true) : [];
      out.push(C('research-sources', used.length > 0 ? 'PASS' : 'WARN',
        `sourcesUsed=${sourcesUsed.length}, used=${used.length}${used.length ? ` (${used.map((s) => s.source).join(',')})` : ' — orchestrator returned an empty evidence pack (transient; external API may have returned no results)'}`));

      const ALLOWED_GROUPS = new Set(['arxiv', 'semantic_scholar', 'github_repo', 'github_code', 'brave']);
      const stray = (Array.isArray(sourcesUsed) ? sourcesUsed : [])
        .map((s) => s?.source).filter((g) => !ALLOWED_GROUPS.has(g));
      out.push(C('research-adapter-surface', stray.length === 0 ? 'PASS' : 'FAIL',
        stray.length ? `unexpected source groups: ${[...new Set(stray)].join(',')}` : `groups subset of {${[...ALLOWED_GROUPS].join(',')}}`));
    }
  }

  // ⑤ quality — does the output contain meaningful, type-appropriate content?
  if (e.kind === 'read' || e.kind === 'write') {
    const [qStatus, qDetail] = checkQuality(e.type, e.subtype, task0, sr);
    out.push(C('quality', qStatus, qDetail));
  }

  // ⑥ contextBlockId
  if (e.kind === 'read' || e.kind === 'write') {
    const cb = task0.contextBlockId;
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
    const cost = task0.cost ?? {};
    const implCost = cost.implementerUsd;
    const hasCost = typeof implCost === 'number' && implCost > 0;
    out.push(C('cost', hasCost ? 'PASS' : 'WARN',
      `implementerUsd=${implCost}`));
  }

  // Session reuse check
  if (e.sessionReuse && rec.resumeSessionId) {
    const actualId = impl.sessionId;
    out.push(C('session-reuse', actualId === rec.resumeSessionId ? 'PASS' : 'WARN',
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

  // Queue (per-dispatch, best-effort)
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `records=${q?.records?.length ?? 0}`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'WARN', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
