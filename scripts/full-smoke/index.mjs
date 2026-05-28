#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { preflight, AbortError } from './preflight.mjs';
import { createProject } from './fixtures.mjs';
import { SCENARIOS } from './config.mjs';
import { runDispatch, pollBatch } from './dispatch.mjs';
import { collectResponse, collectDiagnostics, collectQueue, collectBackend, queueLineCount, allQueueEventIds } from './collectors.mjs';
import { normalize } from './normalize.mjs';
import { verify } from './verify.mjs';
import { extraRouteChecks } from './extra-routes.mjs';
import { report } from './report.mjs';
import { teardown } from './teardown.mjs';
import { runBuildChecks } from './build-checks.mjs';

const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const opts = {
  skipBackend: argv.includes('--skip-backend'),
  strict: argv.includes('--strict'),
  // Build/packaging phase (Bun toolchain + standalone-binary distribution).
  skipBuild: argv.includes('--skip-build'),
  skipTests: argv.includes('--skip-tests'),
  skipDocker: argv.includes('--skip-docker'),
  buildOnly: argv.includes('--build-only'),
  expectBranch: (argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null,
  allowMismatch: argv.includes('--allow-mismatch'),
  // --only=1,13 limits the run to a subset of scenario ids (for quick checks).
  only: onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null,
  // --wait-flush waits out the server's 5-min telemetry flush, then verifies the
  // run's events actually landed in events_raw (the mma→backend→DB leg).
  waitFlush: argv.includes('--wait-flush'),
};

// ── Build + packaging phase (no running server required) ──────────────────
// Validates the Bun toolchain + standalone-binary distribution that the live
// runtime scenarios cannot see. Runs first so a broken build fails fast.
const buildChecks = await runBuildChecks(opts);

if (opts.buildOnly) {
  let fails = 0;
  console.log('Full-smoke — BUILD/PACKAGING phase only\n');
  for (const c of buildChecks) {
    const g = { PASS: '✓', FAIL: '✗', SKIP: '—' }[c.status] ?? c.status;
    console.log(`  ${g} ${c.checkId.padEnd(24)} ${c.detail}`);
    if (c.status === 'FAIL') fails++;
  }
  console.log(`\nbuild/packaging: ${fails === 0 ? 'all checks passed' : `${fails} FAILED`}`);
  process.exit(fails > 0 ? 1 : 0);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run-level wire-record tally: ids already in the queue at run start are the
// baseline (prior runs / unrelated activity) and excluded; seenIds accumulates
// THIS run's ids via full-file reads, so a flusher drain can't lose them.
const baselineIds = new Set(allQueueEventIds());
const seenIds = new Set();
let totalCostUSD = 0;
let expectedEmits = 0;
let backendSummary = null;

try {
  const { dir } = createProject();
  ctx.dir = dir;
  ctx.specMd = readFileSync(`${dir}/spec.md`, 'utf8');

  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.has(String(s.id))) : SCENARIOS;
  for (const spec of scenarios) {
    expectedEmits += spec.emits ?? 0;
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
      // Run-level capture: the wire write lands async AFTER the batch returns
      // terminal, so settle until this scenario's expected `emits` new ids
      // appear (or time out) before moving on — a lagging record then can't be
      // misattributed to the next scenario or dropped from the tally.
      const want = spec.emits ?? 0;
      const startSeen = seenIds.size;
      const settleUntil = Date.now() + 8000;
      for (;;) {
        for (const id of allQueueEventIds()) if (!baselineIds.has(id)) seenIds.add(id);
        if (seenIds.size - startSeen >= want || Date.now() >= settleUntil) break;
        await sleep(300);
      }
      const rec = normalize(spec, {
        response: collectResponse(envelope),
        diagnostics: collectDiagnostics(res.batchId),
        queue, backend: null, // ④ verified run-level after the loop
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

  // Extra live route coverage: introspection (/health, /status, /__routes),
  // batch-slice (POST /control/batch-slice), context-block DELETE — the routes
  // in the manifest that the dispatch scenarios don't hit. Skipped under --only.
  if (!opts.only) {
    try {
      records.push({ scenarioId: 'extra-routes', route: 'controls+introspection' });
      checksByScenario['extra-routes'] = await extraRouteChecks(ctx);
    } catch (err) {
      checksByScenario['extra-routes'] = [{ checkId: 'extra-routes', status: 'FAIL', detail: String(err.message || err) }];
    }
  }

  // Run-level backend (④): correlate by event_id (= queue eventId). The flusher
  // uploads every 5 min, so without --wait-flush these rows won't have landed yet
  // — the durable local proof is the queue (③); --wait-flush verifies DB landing.
  const allEventIds = [...seenIds];
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

// Prepend the build/packaging phase so its checks appear in the report + tally.
records.unshift({ scenarioId: 'build', route: 'build-phase' });
checksByScenario['build'] = buildChecks;

const exitCode = report(records, checksByScenario, {
  serverVersion: ctx.serverVersion, bootId: ctx.bootId,
  mode: opts.skipBackend ? 'REDUCED (--skip-backend)' : 'FULL',
  strict: opts.strict, totalCostUSD,
  backend: backendSummary, queueEventCount: seenIds.size, expectedRows: expectedEmits,
  waitFlush: opts.waitFlush, dbApproved: ctx.dbApproved,
});
process.exit(exitCode);
