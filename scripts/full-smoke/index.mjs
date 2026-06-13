#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { preflight, AbortError } from './preflight.mjs';

// Harness hygiene: the smoke shares ONE git workspace across all scenarios. In
// goal mode a write scenario where the worker under-commits leaves the tree
// dirty, which would fail the NEXT goal-set's clean-tree precondition. Commit
// any leftover here so each scenario's verdict stays independent (the failing
// scenario's own result already records the miss; this just unblocks the rest).
function keepWorkspaceClean(dir) {
  try {
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!dirty) return;
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'smoke-harness: commit leftover uncommitted changes'], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}
import { createProject } from './fixtures.mjs';
import { SCENARIOS } from './config.mjs';
import { runDispatch, pollTask } from './dispatch.mjs';
import { collectResponse, collectDiagnostics, collectQueue, collectBackend, queueLineCount, allQueueEventIds } from './collectors.mjs';
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
  // run's events actually landed in events_raw (the mma->backend->DB leg).
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

  const log = (msg) => { process.stderr.write(msg + '\n'); };
  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.has(String(s.id))) : SCENARIOS;
  log(`Full-pipeline smoke — ${scenarios.length} scenarios queued`);
  for (const spec of scenarios) {
    expectedEmits += spec.emits ?? 0;
    try {
      log(`\n#${spec.id}  ${spec.type ?? spec.kind ?? '?'}  dispatching...`);

      // ─── Error scenarios: dispatch and check status inline ───
      if (spec.kind === 'error') {
        const res = await runDispatch(spec, ctx);
        const rec = normalize(spec, {});
        rec.errorStatus = res.status;
        rec.errorJson = res.json;
        records.push(rec);
        checksByScenario[spec.id] = verify(rec);
        log(`#${spec.id}  ${spec.type ?? '?'}  → HTTP ${res.status}`);
        continue;
      }

      const queueBefore = queueLineCount();
      const res = await runDispatch(spec, ctx);

      // ─── Context-block registration (synchronous 201) ───
      if (res.blockId) {
        ctx.blockId = res.blockId;
        ctx.contextBlockIds.push(res.blockId);
        records.push(normalize(spec, {}));
        checksByScenario[spec.id] = [{ checkId: 'register', status: res.blockId ? 'PASS' : 'FAIL', detail: `blockId=${res.blockId}` }];
        log(`#${spec.id}  context-blocks  → registered blockId=${res.blockId}`);
        continue;
      }

      log(`#${spec.id}  ${spec.type}  → taskId=${res.taskId}  polling...`);
      // ─── Normal task: poll to terminal ───
      const envelope = await pollTask(ctx.token, res.taskId);

      // Capture session from scenario #2 for session reuse in scenario #16
      if (spec.id === 2) {
        const implSession = envelope.results?.[0]?.sessions?.implementer;
        if (implSession?.sessionId) {
          ctx.sessionFromScenario2 = implSession.sessionId;
        }
      }

      const queue = collectQueue(queueBefore);
      // Run-level capture: settle until this scenario's expected `emits` new ids
      // appear (or time out) before moving on.
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
        diagnostics: collectDiagnostics(res.taskId),
        queue, backend: null, // verified run-level after the loop
      });
      // For session reuse scenario, attach the requested session ID for verify
      if (spec.sessionReuse && ctx.sessionFromScenario2) {
        rec.resumeSessionId = ctx.sessionFromScenario2;
      }
      records.push(rec);
      const checks = verify(rec);
      checksByScenario[spec.id] = checks;
      const fails = checks.filter(c => c.status === 'FAIL').length;
      const warns = checks.filter(c => c.status === 'WARN').length;
      const cost = envelope.results?.[0]?.cost?.implementerUsd ?? 0;
      const status = envelope.results?.[0]?.status ?? '?';
      log(`#${spec.id}  ${spec.type}  → ${status}  $${cost.toFixed(4)}  ${fails ? `${fails} FAIL` : warns ? `${warns} WARN` : '✓'}`);
      if (spec.kind === 'write') keepWorkspaceClean(ctx.dir);
      totalCostUSD += envelope.results?.[0]?.telemetry?.totalCostUSD
        ?? envelope.costSummary?.totalActualCostUSD ?? 0;
    } catch (err) {
      records.push(normalize(spec, {}));
      checksByScenario[spec.id] = [{ checkId: 'dispatch', status: 'FAIL', detail: String(err.message || err) }];
      log(`#${spec.id}  ${spec.type ?? '?'}  → DISPATCH FAILED: ${err.message}`);
    }
  }

  // Run-level backend: correlate by event_id. The flusher uploads every 5 min,
  // so without --wait-flush these rows won't have landed yet.
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

const exitCode = report(records, checksByScenario, {
  serverVersion: ctx.serverVersion, bootId: ctx.bootId,
  mode: opts.skipBackend ? 'REDUCED (--skip-backend)' : 'FULL',
  strict: opts.strict, totalCostUSD,
  backend: backendSummary, queueEventCount: seenIds.size, expectedRows: expectedEmits,
  waitFlush: opts.waitFlush, dbApproved: ctx.dbApproved,
});
process.exit(exitCode);
