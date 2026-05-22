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
    lines.push(`#${String(rec.scenarioId).padEnd(4)} ${rec.route.padEnd(16)} ${cells.join('  ')}`);
    for (const c of checks) {
      if (c.status === 'FAIL') { hardFail++; gaps.push(`FAIL  #${rec.scenarioId} ${c.checkId}: ${c.detail}`); }
      if (c.status === 'WARN') { warns++; gaps.push(`WARN  #${rec.scenarioId} ${c.checkId}: ${c.detail}`); }
    }
  }
  // Run-level telemetry: local queue (③, flush-independent) + backend DB landing (④).
  lines.push('');
  const qCount = meta.queueEventCount ?? 0;
  const localOK = qCount >= (meta.expectedRows ?? 1);
  lines.push(`local telemetry (queue): ${GLYPH[localOK ? 'PASS' : 'WARN']} ${qCount} wire records enqueued (expected >=${meta.expectedRows ?? '?'})`);
  if (!localOK) { warns++; gaps.push(`WARN  local-telemetry: only ${qCount} wire records enqueued vs expected ${meta.expectedRows}`); }

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
