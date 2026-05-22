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
