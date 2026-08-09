import { writeFileSync } from 'node:fs';

const GLYPH = { PASS: '✓', FAIL: '✗', WARN: '⚠', NA: '—' };

export function report(records, checksByScenario, meta) {
  const lines = [];
  lines.push(`Full-pipeline smoke — server v${meta.serverVersion} boot ${meta.bootId} — mode ${meta.mode}`);
  lines.push('');
  let hardFail = 0, warns = 0;
  const gaps = [];
  for (const rec of records) {
    const checks = checksByScenario[rec.scenarioId] ?? [];
    const cells = checks.map((c) => `${c.checkId}:${GLYPH[c.status] ?? c.status}`);
    lines.push(`#${String(rec.scenarioId).padEnd(4)} ${rec.type.padEnd(16)} ${cells.join('  ')}`);
    for (const c of checks) {
      if (c.status === 'FAIL') { hardFail++; gaps.push(`FAIL  #${rec.scenarioId} ${c.checkId}: ${c.detail}`); }
      if (c.status === 'WARN') { warns++; gaps.push(`WARN  #${rec.scenarioId} ${c.checkId}: ${c.detail}`); }
    }
  }
  // Run-level telemetry: local queue sample (③) + backend DB landing (④, authoritative).
  //
  // The local queue file is a transient retry buffer that the server's flusher drains AND
  // rewrites every ~5 min. Each time it fires, its upload+rewrite window (~1-3s) overlaps
  // freshly-sealed tasks, so a few just-appended records are removed from the file before the
  // smoke can sample them — and a wire record's eventId is not observable anywhere else (not in
  // the task response), so those few become permanently invisible to a file sampler. This is
  // BOUNDED sampling loss, not a dropped record: every event still uploads to the backend (prove
  // the exact landing with --wait-flush, which queries events_raw). So the local gate verifies
  // telemetry is FLOWING (high capture) and only alarms on a real breakdown (near-zero capture),
  // rather than demanding a perfect file sample it structurally cannot guarantee.
  lines.push('');
  const qCount = meta.queueEventCount ?? 0;
  const exp = meta.expectedRows ?? 1;
  const slack = Math.max(4, Math.ceil(exp * 0.15)); // a few records can race one flush/rewrite window
  const floor = exp - slack;
  const localOK = qCount >= floor;
  const exact = qCount >= exp;
  lines.push(`local telemetry (queue): ${GLYPH[localOK ? 'PASS' : 'WARN']} ${qCount}/${exp} wire records sampled${exact ? ' (all)' : ` (≥${floor} required; up to ${slack} may race the 5-min flush/rewrite window — verify exact backend landing with --wait-flush)`}`);
  if (!localOK) { warns++; gaps.push(`WARN  local-telemetry: only ${qCount}/${exp} wire records sampled — below the ${floor} floor; telemetry may not be flowing (rerun with --wait-flush to verify backend landing in events_raw)`); }

  // Availability across the whole run. This is a RUN-LEVEL property, not a per-scenario one:
  // a daemon that stalls its HTTP layer still lets separate-process workers finish, so every
  // scenario can pass while the service was unreachable. Reported next to telemetry because both
  // answer "was the daemon healthy while working", which no per-scenario check can see.
  if (meta.availability) {
    const a = meta.availability;
    lines.push(`daemon availability: ${GLYPH[a.status] ?? '—'} ${a.detail}`);
    if (a.status === 'FAIL') {
      hardFail++;
      gaps.push(`FAIL  availability: the daemon was unreachable for ${a.longestOutageMs}ms during the run `
        + `(${a.failures}/${a.probes} probes unanswered). Workers keep running through an HTTP wedge, so `
        + `scenario outcomes cannot detect this — look for synchronous work on the daemon event loop.`);
    } else if (a.status === 'WARN') {
      warns++;
      gaps.push(`WARN  availability: slowest /health ${a.slowestMs}ms, longest outage ${a.longestOutageMs}ms — `
        + `the daemon stalled but callers probably survived it.`);
    }
  }

  if (meta.backend) {
    const matched = meta.backend.matched?.length ?? 0;
    const queried = meta.backend.queried ?? 0;
    if (meta.waitFlush) {
      const status = matched > 0 ? 'PASS' : 'FAIL';
      lines.push(`backend DB (event_id): ${GLYPH[status]} ${matched}/${queried} rows landed in events_raw${meta.dbApproved ? '' : ' [remote DB: read-only, rows NOT deleted]'}`);
      if (status === 'FAIL') { hardFail++; gaps.push(`FAIL  backend: 0/${queried} run events found in events_raw after flush wait — telemetry not reaching the DB`); }
    } else {
      // No flush wait: rows almost certainly not uploaded yet (5-min flush). NA, not a fail.
      lines.push(`backend DB (event_id): — ${matched}/${queried} found now (flush is 5-min; rerun with --wait-flush to verify DB landing)`);
    }
  } else if (meta.mode.startsWith('REDUCED')) {
    lines.push('backend DB: — (--skip-backend)');
  }
  lines.push('');
  lines.push(`cumulative cost: $${(meta.totalCostUSD ?? 0).toFixed(4)}   hard-fails: ${hardFail}   warns: ${warns}`);
  lines.push('');
  lines.push('GAPS / ISSUES TO WORK ON:');
  lines.push(...(gaps.length ? gaps : ['  (none)']));
  console.log(lines.join('\n'));

  writeFileSync('full-smoke-results.json', JSON.stringify({ meta, records, checksByScenario }, null, 2));
  console.log('\nwrote full-smoke-results.json');

  const failCount = meta.strict ? hardFail + warns : hardFail;
  return failCount > 0 ? 1 : 0;
}
