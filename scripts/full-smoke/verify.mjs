import { SCHEMA_VERSION } from './config.mjs';

const C = (checkId, status, detail = '') => ({ checkId, status, detail });
const SHA40 = /^[a-f0-9]{40}$/;

export function verify(rec) {
  const out = [];
  const { response: r, diagnostics: d, queue: q, backend: b, expect: e } = rec;

  // Assist routes (register/retry): minimal envelope check.
  if (e.kind === 'assist') {
    out.push(C('response', r && (r.error?.kind === 'not_applicable' || r.results?.length) ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
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
    if (e.expectCommitSkip) {
      out.push(C('commit-skip', sr.commitSkipReason === e.expectCommitSkip ? 'PASS' : 'FAIL', `commitSkipReason=${sr.commitSkipReason} commitSha=${sr.commitSha}`));
    } else if (e.reviewPolicy === 'none') {
      const skipped = ['reviewing', 'reworking'].every((n) => !names.includes(n) || outcomeOf(n) === 'skipped');
      out.push(C('review-skipped', skipped ? 'PASS' : 'FAIL', `stages=${JSON.stringify(stages.map((s) => [s.name, s.outcome]))}`));
      out.push(C('commitSha', SHA40.test(sr.commitSha ?? '') ? 'PASS' : 'FAIL', `commitSha=${sr.commitSha}`));
    } else {
      out.push(C('commitSha', SHA40.test(sr.commitSha ?? '') ? 'PASS' : 'FAIL', `commitSha=${sr.commitSha}`));
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

  // ③/④ telemetry presence + correlation
  const inQueue = (q?.records?.length ?? 0) > 0;
  if (b === null) {
    out.push(C('queue', inQueue ? 'PASS' : 'WARN', `③ snapshot records=${q?.records?.length ?? 0}`));
    out.push(C('backend', 'NA', '--skip-backend'));
  } else {
    const inBackend = (b.byEvent?.length ?? 0) > 0 || (b.windowCount ?? 0) > 0;
    // Remote/async ingestion lag means an early dispatch's row may not have landed
    // within the per-dispatch poll window — that's a WARN (best-effort), not a hard
    // FAIL. A run-level backend check (all rows after a final settle) is the proper
    // verification; per-dispatch is indicative only. See known-limitation note.
    out.push(C('telemetry-record', inQueue || inBackend ? 'PASS' : 'WARN', `queue=${inQueue} backend(rows=${b.byEvent?.length},window=${b.windowCount}) — WARN may be ingestion lag`));
  }
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'WARN', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
