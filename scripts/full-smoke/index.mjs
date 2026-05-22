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
  // --wait-flush waits out the server's 5-min telemetry flush, then verifies the
  // run's events actually landed in events_raw (the mma→backend→DB leg).
  waitFlush: argv.includes('--wait-flush'),
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
const allEventIds = [];
let totalCostUSD = 0;
let batchTaskCount = 0;
let backendSummary = null;

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
      allEventIds.push(...queue.eventIds);
      const rec = normalize(spec, {
        response: collectResponse(envelope),
        diagnostics: collectDiagnostics(res.batchId),
        queue, backend: null, // ④ verified run-level after the loop
      });
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      batchTaskCount += Array.isArray(envelope.results) ? envelope.results.length : 1;
      totalCostUSD += envelope.results?.[0]?.telemetry?.totalCostUSD
        ?? envelope.costSummary?.totalActualCostUSD ?? 0;
    } catch (err) {
      records.push(normalize(spec, {}));
      checksByScenario[spec.id] = [{ checkId: 'dispatch', status: 'FAIL', detail: String(err.message || err) }];
    }
  }

  // Run-level backend (④): correlate by event_id (= queue eventId). The flusher
  // uploads every 5 min, so without --wait-flush these rows won't have landed yet
  // — the durable local proof is the queue (③); --wait-flush verifies DB landing.
  ctx.allEventIds = allEventIds;
  if (!opts.skipBackend) {
    if (opts.waitFlush) {
      console.error('[smoke] --wait-flush: waiting ~5.5m for the 5-min telemetry flusher before the backend DB check...');
      await new Promise((r) => setTimeout(r, 330000));
    }
    backendSummary = collectBackend(ctx.databaseUrl, allEventIds);
  }
} finally {
  await teardown(ctx);
}

const exitCode = report(records, checksByScenario, {
  serverVersion: ctx.serverVersion, bootId: ctx.bootId,
  mode: opts.skipBackend ? 'REDUCED (--skip-backend)' : 'FULL',
  strict: opts.strict, totalCostUSD,
  backend: backendSummary, queueEventCount: allEventIds.length, expectedRows: batchTaskCount,
  waitFlush: opts.waitFlush, dbApproved: ctx.dbApproved,
});
process.exit(exitCode);
