import { SCHEMA_VERSION } from './config.mjs';

const C = (checkId, status, detail = '') => ({ checkId, status, detail });
const SHA40 = /^[a-f0-9]{40}$/;

export function verify(rec) {
  const out = [];
  const { response: r, diagnostics: d, queue: q, backend: b, expect: e } = rec;

  // Assist routes (register/retry): minimal envelope check.
  if (e.kind === 'assist') {
    out.push(C('response', r && (r.error?.kind === 'not_applicable' || r.results?.length) ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    // retry re-runs a write-route (delegate) task → its terminal contextBlockId
    // must be null (write routes register no block). register-context-block has
    // no task result (returns { id }), so only check when results are present.
    if (e.type === 'retry_tasks' && r?.results?.length) {
      const cb = r.results[0]?.contextBlockId;
      out.push(C('context-block', cb === null ? 'PASS' : 'WARN', `contextBlockId=${cb} (retry of a write task → expect null)`));
    }
    return out;
  }

  const sr = r?.structuredReport ?? {};
  const task0 = r?.results?.[0] ?? {};
  const stages = task0.stages ?? [];
  const names = stages.map((s) => s.name);
  const outcomeOf = (n) => stages.find((s) => s.name === n)?.outcome;

  // Skill passthrough — negative path (scenario 18): the batch itself completes
  // (error.kind = not_applicable) but the single task must hard-fail because its
  // named skill can't be resolved. Assert the task did NOT succeed AND the
  // expected typed code surfaces somewhere on the task result. Early-return so
  // the normal write checks (commit/terminal) don't run on a deliberately-failed
  // task.
  if (e.expectSkillError) {
    const st = task0.status;
    const failed = st && st !== 'done' && st !== 'ok' && st !== 'done_with_concerns';
    const hasCode = JSON.stringify(task0).includes(e.expectSkillError);
    out.push(C('skill-error', failed && hasCode ? 'PASS' : 'FAIL',
      `status=${st}; result carries '${e.expectSkillError}'=${hasCode}`));
    return out;
  }

  // ① response
  if (e.expectFail) {
    out.push(C('response', r?.error && r.error.code ? 'PASS' : 'FAIL', `expected failure; error=${JSON.stringify(r?.error)}`));
  } else {
    out.push(C('response', r?.error?.kind === 'not_applicable' ? 'PASS' : 'FAIL', JSON.stringify(r?.error)));
  }

  if (e.kind === 'write' && !e.expectFail) {
    // The aggregate structuredReport reflects TASK 0 only. For multi-task batches
    // (parallel/serial delegate with >1 task, execute-plan), a null aggregate
    // commitSha is a WARN (task 0 may have no-op'd while siblings committed), not
    // a hard FAIL — per-task commit isn't exposed on the response results[].
    //
    // A null commitSha WITH a commitSkipReason (e.g. no_diff) is a legitimate
    // worker outcome — the LLM may non-deterministically produce content
    // identical to the seed, leaving nothing to commit. That's PASS (reason
    // shown). Only a null commitSha with NO skip reason is the real "lost
    // commit" bug class → FAIL (or WARN for multi-task aggregates).
    const multiTask = (e.tasks && e.tasks > 1) || e.type === 'execute_plan';
    const committed = SHA40.test(sr.commitSha ?? '');
    const labeledSkip = !committed && typeof sr.commitSkipReason === 'string' && sr.commitSkipReason.length > 0;
    // reviewPolicy:'none' has no phase-2 guarantor (design choice: trust the
    // standard tier), so an uncommitted result is a tier reliability issue, not
    // a system bug → WARN, not FAIL.
    const softCommit = multiTask || e.reviewPolicy === 'none';
    const commitVerdict = committed || labeledSkip ? 'PASS' : (softCommit ? 'WARN' : 'FAIL');
    const commitDetail = `commitSha=${sr.commitSha}${labeledSkip ? ` (skipped: ${sr.commitSkipReason})` : ''}${multiTask ? ' (aggregate = task 0 only)' : ''}`;
    if (e.expectCommitSkip) {
      out.push(C('commit-skip', sr.commitSkipReason === e.expectCommitSkip ? 'PASS' : 'FAIL', `commitSkipReason=${sr.commitSkipReason} commitSha=${sr.commitSha}`));
    } else if (e.reviewPolicy === 'none') {
      const skipped = ['reviewing', 'reworking'].every((n) => !names.includes(n) || outcomeOf(n) === 'skipped');
      out.push(C('review-skipped', skipped ? 'PASS' : 'FAIL', `stages=${JSON.stringify(stages.map((s) => [s.name, s.outcome]))}`));
      out.push(C('commitSha', commitVerdict, commitDetail));
    } else {
      out.push(C('commitSha', commitVerdict, commitDetail));
      out.push(C('review-ran', names.includes('reviewing') ? 'PASS' : 'FAIL', `stages=${names}`));
      if (e.expectRework === 'best-effort') {
        out.push(C('rework', outcomeOf('reworking') === 'advance' ? 'PASS' : 'WARN', `rework outcome=${outcomeOf('reworking')} (best-effort)`));
      }
    }
  }
  // Goal mode (5.1.0): commit subject follows the `[task N] …` convention the
  // annotator keys on (optionally `[task N] fix: …` for the review-fix phase),
  // NOT a chain-of-thought leak.
  if (e.kind === 'write' && !e.expectFail && SHA40.test(sr.commitSha ?? '') && typeof sr.commitMessage === 'string') {
    const subj = sr.commitMessage.split('\n')[0];
    const goalConvention = /^\[task \d+\] \S/.test(subj);
    const leak = /(i'?ll\b|i will\b|let me\b|looking at\b|you maintain\b|your job\b|i need to\b)/i.test(subj);
    out.push(C('commit-msg-format', goalConvention && !leak ? 'PASS' : 'FAIL', `subject="${subj.slice(0, 80)}"`));
  }
  // Fix C (4.8.0): a successful write task reaches a done terminal status —
  // not a spurious `failed` (parse-miss reconciliation / review fit). The
  // `expectRework` scenario is the one DELIBERATELY-contradictory prompt
  // ("you may skip the tests" vs done="implemented AND unit-tested") — its
  // worker may honestly self-assess `failed` and the reviewer may return no
  // parseable verdict (so Fix C correctly preserves the self-report rather
  // than reconciling). That's a legitimate outcome, not the spurious-failure
  // bug, so it's a WARN there (same rationale as its best-effort rework check)
  // and a hard FAIL on every unambiguous write task.
  if (e.kind === 'write' && !e.expectFail) {
    const st = task0.status;
    const ok = st === 'done' || st === 'done_with_concerns';
    // reviewPolicy:'none' has no guarantor → a failed seal is tier reliability,
    // not a system bug (same soft rationale as expectRework).
    const soft = e.expectRework || e.reviewPolicy === 'none';
    out.push(C('terminal-status', ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'),
      `status=${st}${!ok && soft ? ' (no-guarantor / ambiguous scenario → soft)' : ''}`));
  }

  // Skill passthrough — positive path (scenario 17): the worker LAUNCHED and RAN
  // with a resolved+staged skill. The proof of resolve→stage→native delivery is
  // that the implementing stage advanced (a staging failure short-circuits BEFORE
  // implement, to a skill_* error) and the result carries no skill_* error code.
  // It is NOT the commit/terminal outcome — a reviewPolicy:'none' scenario may
  // soft-fail on the commit (no guarantor) yet still have equipped the skill.
  if (e.skills && !e.expectSkillError) {
    const ran = outcomeOf('implementing') === 'advance';
    const noSkillErr = !JSON.stringify(task0).includes('skill_');
    out.push(C('skill-equipped', ran && noSkillErr ? 'PASS' : 'FAIL',
      `skills=${JSON.stringify(e.skills)} ran=${ran} status=${task0.status} noSkillError=${noSkillErr}`));
  }

  if (e.kind === 'read') {
    const findings = sr.findings ?? task0.findings ?? [];
    out.push(C('findings', Array.isArray(findings) ? 'PASS' : 'FAIL', `n=${findings.length}`));

    // research delivers EVIDENCE, not just a well-formed shell. The empty-
    // evidence failure mode — worker emits N `## Finding` blocks with no
    // Evidence bullet because the Step-2 orchestrator's bibliographic adapters
    // (arxiv/SS/Brave) returned nothing — sails through the Array.isArray
    // check above. Assert the deliverable is real: non-empty findings that
    // actually carry evidence, AND a sources table showing ≥1 source was
    // used (proves the evidence pack was non-empty, i.e. adapters were healthy).
    if (e.type === 'research') {
      // Empty findings is a LEGITIMATE outcome per the mma-research contract
      // (empty ≠ failure) — synthesis is content-dependent and can be low-yield
      // on a given run even when the route worked (status done, sources fetched).
      // So research-evidence only hard-FAILs the structural bug: findings that
      // EXIST but carry no evidence (the fabricated/empty-evidence mode). Zero
      // findings is a WARN — visible, promotable under --strict. Adapter health
      // is proven independently by research-sources below.
      const withEvidence = findings.some((f) => typeof f?.evidence === 'string' && f.evidence.trim().length > 0);
      const evidenceVerdict = findings.length === 0 ? 'WARN' : (withEvidence ? 'PASS' : 'FAIL');
      out.push(C('research-evidence', evidenceVerdict,
        findings.length === 0
          ? 'worker synthesized 0 findings (empty ≠ failure per contract; sources were fetched)'
          : `findings=${findings.length}; ${findings.filter((f) => f?.evidence?.trim()).length} carry evidence`));

      const sourcesUsed = sr.sourcesUsed ?? task0.sourcesUsed ?? [];
      const used = Array.isArray(sourcesUsed) ? sourcesUsed.filter((s) => s?.used === true) : [];
      out.push(C('research-sources', used.length > 0 ? 'PASS' : 'FAIL',
        `sourcesUsed=${sourcesUsed.length}, used=${used.length}${used.length ? ` (${used.map((s) => s.source).join(',')})` : ' — orchestrator returned an empty evidence pack'}`));

      // The sources table must report ONLY the supported adapter groups. rss /
      // web_fetch were removed from the pipeline — their reappearance here (or
      // any unknown group) is a regression. Covers the full adapter surface.
      const ALLOWED_GROUPS = new Set(['arxiv', 'semantic_scholar', 'github_repo', 'github_code', 'brave']);
      const stray = (Array.isArray(sourcesUsed) ? sourcesUsed : [])
        .map((s) => s?.source).filter((g) => !ALLOWED_GROUPS.has(g));
      out.push(C('research-adapter-surface', stray.length === 0 ? 'PASS' : 'FAIL',
        stray.length ? `unexpected source groups: ${[...new Set(stray)].join(',')}` : `groups ⊆ {${[...ALLOWED_GROUPS].join(',')}}`));
    }
  }

  // contextBlockId surfacing — universal terminal context block (4.7.20).
  // Read routes auto-register a terminal block → non-null contextBlockId on the
  // per-task result. Write routes register none → contextBlockId is exactly null.
  // `undefined` means the field was not projected onto /task (the pre-4.7.20 bug)
  // → FAIL. This is the direct regression guard for the feature.
  if (!e.expectFail && (e.kind === 'read' || e.kind === 'write')) {
    const cb = task0.contextBlockId;
    if (e.kind === 'read') {
      const ok = typeof cb === 'string' && cb.length > 0;
      // research is a network aggregation route; a null here is a soft WARN
      // (worker may not have completed), not a hard regression signal.
      out.push(C('context-block', ok ? 'PASS' : (e.type === 'research' ? 'WARN' : 'FAIL'),
        `contextBlockId=${cb} (read route → expect non-null id)`));
    } else {
      out.push(C('context-block', cb === null ? 'PASS' : 'FAIL',
        `contextBlockId=${cb} (write route → expect exactly null; undefined = not projected)`));
    }
  }

  // ② diagnostics
  if (d && d.events.length) {
    const kinds = [...new Set(d.events.map((x) => x.kind))];
    const terminal = kinds.includes('batch_completed') || kinds.includes('batch_failed');
    out.push(C('diag-events', kinds.includes('batch_created') && terminal ? 'PASS' : 'FAIL', `kinds=${kinds}`));
    if (e.dispatchMode) out.push(C('dispatch_mode', d.dispatchMode === e.dispatchMode ? 'PASS' : 'FAIL', `got=${d.dispatchMode} want=${e.dispatchMode}`));
    // sessionId IS present in diagnostics. A task uses 2 sessions only when the
    // implementer tier differs from the reviewer/annotate tier; same-tier no-review
    // tasks legitimately use 1. Report the count; PASS for 1-2, WARN for 0 or >2.
    const sessionIds = new Set(d.events.flatMap((x) => (x.fields?.sessionId ? [x.fields.sessionId] : [])));
    // sessionId is not consistently emitted in diagnostics (esp. read routes) →
    // NA when absent rather than a false WARN. 1-2 distinct ids = PASS (2 only on
    // cross-tier tasks; 1 on same-tier/no-review). >2 is unexpected.
    out.push(C('sessions', sessionIds.size === 0 ? 'NA' : (sessionIds.size <= 2 ? 'PASS' : 'WARN'),
      `distinct sessionIds=${sessionIds.size} (NA = diagnostics expose no sessionId for this route)`));
  } else {
    out.push(C('diag-events', 'WARN', 'no diagnostics events found for batch'));
  }

  // ③ queue (per-dispatch, best-effort — flusher may drain before we read; the
  // durable telemetry check is run-level against the backend, see report.mjs).
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `③ records=${q?.records?.length ?? 0} (best-effort; flush may drain → verified run-level in backend)`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'WARN', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
