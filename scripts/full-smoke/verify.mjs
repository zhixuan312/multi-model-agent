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
    if (e.route === 'retry' && r?.results?.length) {
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
    const multiTask = (e.tasks && e.tasks > 1) || e.route === 'execute-plan';
    const committed = SHA40.test(sr.commitSha ?? '');
    const labeledSkip = !committed && typeof sr.commitSkipReason === 'string' && sr.commitSkipReason.length > 0;
    const commitVerdict = committed || labeledSkip ? 'PASS' : (multiTask ? 'WARN' : 'FAIL');
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
  if (e.kind === 'read') {
    const findings = sr.findings ?? task0.findings ?? [];
    out.push(C('findings', Array.isArray(findings) ? 'PASS' : 'FAIL', `n=${findings.length}`));
  }

  // contextBlockId surfacing — universal terminal context block (4.7.20).
  // Read routes auto-register a terminal block → non-null contextBlockId on the
  // per-task result. Write routes register none → contextBlockId is exactly null.
  // `undefined` means the field was not projected onto /batch (the pre-4.7.20 bug)
  // → FAIL. This is the direct regression guard for the feature.
  if (!e.expectFail && (e.kind === 'read' || e.kind === 'write')) {
    const cb = task0.contextBlockId;
    if (e.kind === 'read') {
      const ok = typeof cb === 'string' && cb.length > 0;
      // research is a network aggregation route; a null here is a soft WARN
      // (worker may not have completed), not a hard regression signal.
      out.push(C('context-block', ok ? 'PASS' : (e.route === 'research' ? 'WARN' : 'FAIL'),
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
