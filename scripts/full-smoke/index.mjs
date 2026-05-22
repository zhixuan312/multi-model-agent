#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { preflight, AbortError } from './preflight.mjs';
import { createProject } from './fixtures.mjs';
import { SCENARIOS } from './config.mjs';
import { runDispatch, pollBatch } from './dispatch.mjs';
import { collectResponse, collectDiagnostics, collectQueue, collectBackend, queueLineCount } from './collectors.mjs';
import { normalize } from './normalize.mjs';
import { verify } from './verify.mjs';
import { report } from './report.mjs';
import { teardown } from './teardown.mjs';

const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const opts = {
  skipBackend: argv.includes('--skip-backend'),
  strict: argv.includes('--strict'),
  expectBranch: (argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null,
  allowMismatch: argv.includes('--allow-mismatch'),
  // --only=1,13 limits the run to a subset of scenario ids (for quick checks).
  only: onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null,
};

let ctx;
try {
  ctx = await preflight(opts);
} catch (e) {
  if (e instanceof AbortError) { console.error(e.message); process.exit(2); }
  throw e;
}

ctx.contextBlockIds = [];
const records = [];
const checksByScenario = {};
let totalCostUSD = 0;

try {
  const { dir } = createProject();
  ctx.dir = dir;
  ctx.specMd = readFileSync(`${dir}/spec.md`, 'utf8');

  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.has(String(s.id))) : SCENARIOS;
  for (const spec of scenarios) {
    try {
      const queueBefore = queueLineCount();
      const res = await runDispatch(spec, ctx);
      if (res.blockId) {
        ctx.blockId = res.blockId;
        ctx.contextBlockIds.push(res.blockId);
        records.push(normalize(spec, {}));
        checksByScenario[spec.id] = [{ checkId: 'register', status: res.blockId ? 'PASS' : 'FAIL', detail: `blockId=${res.blockId}` }];
        continue;
      }
      const envelope = await pollBatch(ctx.token, res.batchId);
      if (spec.id === 'seed') {
        ctx.seedBatchId = res.batchId;
        const results = Array.isArray(envelope.results) ? envelope.results : [];
        const idx = results.findIndex((t) => t.status && t.status !== 'done' && t.status !== 'ok');
        ctx.seedFailIdx = idx >= 0 ? idx : 0;
      }
      const queue = collectQueue(queueBefore);
      const backend = opts.skipBackend ? null
        : await collectBackend(ctx.databaseUrl, queue.eventIds, ctx.installId, ctx.runStartTs);
      const rec = normalize(spec, {
        response: collectResponse(envelope),
        diagnostics: collectDiagnostics(res.batchId),
        queue, backend,
      });
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      totalCostUSD += envelope.results?.[0]?.telemetry?.totalCostUSD
        ?? envelope.costSummary?.totalActualCostUSD ?? 0;
    } catch (err) {
      records.push(normalize(spec, {}));
      checksByScenario[spec.id] = [{ checkId: 'dispatch', status: 'FAIL', detail: String(err.message || err) }];
    }
  }
} finally {
  await teardown(ctx);
}

const exitCode = report(records, checksByScenario, {
  serverVersion: ctx.serverVersion, bootId: ctx.bootId,
  mode: opts.skipBackend ? 'REDUCED (--skip-backend)' : 'FULL',
  strict: opts.strict, totalCostUSD,
});
process.exit(exitCode);
