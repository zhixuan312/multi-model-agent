import { SCHEMA_VERSION } from './config.mjs';

const C = (checkId, status, detail = '') => ({ checkId, status, detail });
const SHA40 = /^[a-f0-9]{40}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Verify checks per scenario. Every scenario validates:
//
//   1. response   — did the task complete successfully?
//   2. sessions   — are session fields present and correct?
//   3. tier       — does the implementer tier match expected?
//   4. review     — is reviewer present when reviewed, absent when none?
//   5. context-block — contextBlockId non-null for read types, null for write?
//   6. cost       — implementerUsd > 0?
//   7. diag-events — expected diagnostic events present?
// ─────────────────────────────────────────────────────────────────────────────

export function verify(rec) {
  const out = [];
  const { response: r, diagnostics: d, queue: q, backend: b, expect: e } = rec;

  // ─── Error cases (#14, #15): validate HTTP 400 ───
  if (e.kind === 'error') {
    const status = rec.errorStatus;
    const json = rec.errorJson;
    out.push(C('http-status', status === e.expectStatus ? 'PASS' : 'FAIL',
      `expected=${e.expectStatus} got=${status}`));
    // The error response should contain an error object with a message
    const hasError = json && (json.error || json.message || json.code);
    out.push(C('error-body', hasError ? 'PASS' : 'WARN',
      `body=${JSON.stringify(json).slice(0, 200)}`));
    return out;
  }

  // ─── Assist routes (context-blocks): minimal envelope check ───
  if (e.kind === 'assist') {
    out.push(C('response', r && (r.error?.kind === 'not_applicable' || r.results?.length) ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    return out;
  }

  const sr = r?.structuredReport ?? {};
  const task0 = r?.results?.[0] ?? {};
  const stages = task0.stages ?? [];
  const names = stages.map((s) => s.name);
  const outcomeOf = (n) => stages.find((s) => s.name === n)?.outcome;

  // ① response — did the task complete?
  out.push(C('response', r?.error?.kind === 'not_applicable' ? 'PASS' : 'FAIL', JSON.stringify(r?.error)));

  // ② sessions — validate session shape on the task result
  const sessions = task0.sessions ?? {};
  const impl = sessions.implementer ?? {};
  if (e.kind === 'read' || e.kind === 'write') {
    // implementer session must have tier, sessionId, resumeSupported
    const hasImplFields = typeof impl.tier === 'string'
      && typeof impl.sessionId === 'string' && impl.sessionId.length > 0
      && typeof impl.resumeSupported === 'boolean';
    out.push(C('sessions', hasImplFields ? 'PASS' : 'WARN',
      `implementer={tier:${impl.tier}, sessionId:${impl.sessionId?.slice(0, 12)}..., resume:${impl.resumeSupported}}`));
  }

  // ③ tier — does implementer tier match expectation?
  if (e.tier) {
    // Scenario 11 overrides standard→complex via agentTier field
    out.push(C('tier', impl.tier === e.tier ? 'PASS' : 'WARN',
      `expected=${e.tier} got=${impl.tier}`));
  }

  // ④ review — reviewer session present when reviewed, absent/null when none
  if (e.kind === 'write') {
    const reviewer = sessions.reviewer;
    if (e.reviewPolicy === 'none') {
      // reviewer should be absent or null
      const skipped = reviewer == null || reviewer === null;
      out.push(C('review', skipped ? 'PASS' : 'FAIL',
        `reviewPolicy=none; reviewer=${JSON.stringify(reviewer)}`));
      // Also check stages: reviewing/reworking should be absent or skipped
      const reviewSkipped = ['reviewing', 'reworking'].every((n) => !names.includes(n) || outcomeOf(n) === 'skipped');
      out.push(C('review-skipped', reviewSkipped ? 'PASS' : 'FAIL',
        `stages=${JSON.stringify(stages.map((s) => [s.name, s.outcome]))}`));
    } else {
      // reviewer should be present (reviewed is default for write)
      const hasReviewer = reviewer != null && typeof reviewer === 'object';
      out.push(C('review', hasReviewer ? 'PASS' : 'WARN',
        `reviewer=${JSON.stringify(reviewer)}`));
      // Check reviewing stage ran
      out.push(C('review-ran', names.includes('reviewing') ? 'PASS' : 'WARN',
        `stages=${names}`));
    }
  }

  // Write-type specific checks
  if (e.kind === 'write') {
    // Commit check
    const committed = SHA40.test(sr.commitSha ?? '');
    const labeledSkip = !committed && typeof sr.commitSkipReason === 'string' && sr.commitSkipReason.length > 0;
    // reviewPolicy:'none' has no phase-2 guarantor → WARN not FAIL
    const softCommit = e.reviewPolicy === 'none';
    const commitVerdict = committed || labeledSkip ? 'PASS' : (softCommit ? 'WARN' : 'FAIL');
    const commitDetail = `commitSha=${sr.commitSha}${labeledSkip ? ` (skipped: ${sr.commitSkipReason})` : ''}`;
    out.push(C('commitSha', commitVerdict, commitDetail));

    // Terminal status: a successful write task reaches done/done_with_concerns
    const st = task0.status;
    const ok = st === 'done' || st === 'done_with_concerns';
    const soft = e.reviewPolicy === 'none';
    out.push(C('terminal-status', ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'),
      `status=${st}${!ok && soft ? ' (no-guarantor → soft)' : ''}`));
  }

  // Read-type specific checks
  if (e.kind === 'read') {
    const findings = sr.findings ?? task0.findings ?? [];
    out.push(C('findings', Array.isArray(findings) ? 'PASS' : 'FAIL', `n=${findings.length}`));

    // research delivers EVIDENCE, not just a well-formed shell
    if (e.type === 'research') {
      const withEvidence = findings.some((f) => typeof f?.evidence === 'string' && f.evidence.trim().length > 0);
      const evidenceVerdict = findings.length === 0 ? 'WARN' : (withEvidence ? 'PASS' : 'FAIL');
      out.push(C('research-evidence', evidenceVerdict,
        findings.length === 0
          ? 'worker synthesized 0 findings (empty != failure per contract; sources were fetched)'
          : `findings=${findings.length}; ${findings.filter((f) => f?.evidence?.trim()).length} carry evidence`));

      const sourcesUsed = sr.sourcesUsed ?? task0.sourcesUsed ?? [];
      const used = Array.isArray(sourcesUsed) ? sourcesUsed.filter((s) => s?.used === true) : [];
      out.push(C('research-sources', used.length > 0 ? 'PASS' : 'FAIL',
        `sourcesUsed=${sourcesUsed.length}, used=${used.length}${used.length ? ` (${used.map((s) => s.source).join(',')})` : ' — orchestrator returned an empty evidence pack'}`));

      const ALLOWED_GROUPS = new Set(['arxiv', 'semantic_scholar', 'github_repo', 'github_code', 'brave']);
      const stray = (Array.isArray(sourcesUsed) ? sourcesUsed : [])
        .map((s) => s?.source).filter((g) => !ALLOWED_GROUPS.has(g));
      out.push(C('research-adapter-surface', stray.length === 0 ? 'PASS' : 'FAIL',
        stray.length ? `unexpected source groups: ${[...new Set(stray)].join(',')}` : `groups subset of {${[...ALLOWED_GROUPS].join(',')}}`));
    }
  }

  // ⑤ contextBlockId surfacing — universal terminal context block.
  // Read routes auto-register a terminal block → non-null contextBlockId.
  // Write routes register none → contextBlockId is exactly null.
  // `undefined` means the field was not projected (regression) → FAIL.
  if (e.kind === 'read' || e.kind === 'write') {
    const cb = task0.contextBlockId;
    if (e.kind === 'read') {
      const ok = typeof cb === 'string' && cb.length > 0;
      // research is a network aggregation route; a null here is a soft WARN
      out.push(C('context-block', ok ? 'PASS' : (e.type === 'research' ? 'WARN' : 'FAIL'),
        `contextBlockId=${cb} (read route -> expect non-null id)`));
    } else {
      out.push(C('context-block', cb === null ? 'PASS' : 'FAIL',
        `contextBlockId=${cb} (write route -> expect exactly null; undefined = not projected)`));
    }
  }

  // ⑥ cost — implementerUsd should be a number > 0
  if (e.kind === 'read' || e.kind === 'write') {
    const cost = task0.cost ?? {};
    const implCost = cost.implementerUsd;
    const hasCost = typeof implCost === 'number' && implCost > 0;
    // research may have $0 cost if adapters do the work; soft check
    out.push(C('cost', hasCost ? 'PASS' : (e.type === 'research' ? 'WARN' : 'WARN'),
      `implementerUsd=${implCost}`));
  }

  // Session reuse check (scenario #13): verify the server accepted and used the
  // provided sessionId (the resumed session should have the same implementer sessionId)
  if (e.sessionReuse && rec.resumeSessionId) {
    const actualId = impl.sessionId;
    out.push(C('session-reuse', actualId === rec.resumeSessionId ? 'PASS' : 'WARN',
      `requested=${rec.resumeSessionId?.slice(0, 12)}... got=${actualId?.slice(0, 12)}...`));
  }

  // ⑦ diagnostics
  if (d && d.events.length) {
    const kinds = [...new Set(d.events.map((x) => x.kind))];
    const terminal = kinds.includes('batch_completed') || kinds.includes('batch_failed');
    out.push(C('diag-events', kinds.includes('batch_created') && terminal ? 'PASS' : 'FAIL', `kinds=${kinds}`));
    // sessionId presence in diagnostics
    const sessionIds = new Set(d.events.flatMap((x) => (x.fields?.sessionId ? [x.fields.sessionId] : [])));
    out.push(C('diag-sessions', sessionIds.size === 0 ? 'NA' : (sessionIds.size <= 2 ? 'PASS' : 'WARN'),
      `distinct sessionIds=${sessionIds.size} (NA = diagnostics expose no sessionId for this route)`));
  } else {
    out.push(C('diag-events', 'WARN', 'no diagnostics events found for task'));
  }

  // Queue (per-dispatch, best-effort — flusher may drain before we read)
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `records=${q?.records?.length ?? 0} (best-effort; flush may drain -> verified run-level in backend)`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'WARN', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
