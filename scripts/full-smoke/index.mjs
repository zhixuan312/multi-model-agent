#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { preflight, AbortError } from './preflight.mjs';

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
  only: onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null,
  waitFlush: argv.includes('--wait-flush'),
  sequential: argv.includes('--sequential'),
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
const baselineIds = new Set(allQueueEventIds());
const seenIds = new Set();
let totalCostUSD = 0;
let expectedEmits = 0;
let backendSummary = null;

// ── Run a single scenario to completion and record results ──
async function runScenario(spec, ctx, log) {
  expectedEmits += spec.emits ?? 0;
  try {
    log(`#${spec.id}  ${spec.type ?? spec.kind ?? '?'}  dispatching...`);

    if (spec.kind === 'error') {
      const res = await runDispatch(spec, ctx);
      const rec = normalize(spec, {});
      rec.errorStatus = res.status;
      rec.errorJson = res.json;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  ${spec.type ?? '?'}  → HTTP ${res.status}`);
      return;
    }

    const queueBefore = queueLineCount();
    const res = await runDispatch(spec, ctx);

    if (res.blockId) {
      ctx.blockId = res.blockId;
      ctx.contextBlockIds.push(res.blockId);
      records.push(normalize(spec, {}));
      checksByScenario[spec.id] = [{ checkId: 'register', status: res.blockId ? 'PASS' : 'FAIL', detail: `blockId=${res.blockId}` }];
      log(`#${spec.id}  context-blocks  → registered blockId=${res.blockId}`);
      return;
    }

    log(`#${spec.id}  ${spec.type}  → taskId=${res.taskId}  polling...`);
    const { envelope, polling202 } = await pollTask(ctx.token, res.taskId);

    if (spec.id === 2) {
      const implSessionId = envelope.execution?.sessions?.implementer;
      if (implSessionId) ctx.sessionFromScenario2 = implSessionId;
    }
    if (spec.id === 4) {
      const cb = envelope.output?.contextBlockId;
      if (cb) ctx.auditContextBlockId = cb;
    }

    const queue = collectQueue(queueBefore);
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
      queue, backend: null,
    });
    if (polling202) rec.polling202 = polling202;
    if (spec.sessionReuse && ctx.sessionFromScenario2) {
      rec.resumeSessionId = ctx.sessionFromScenario2;
    }
    records.push(rec);
    const checks = verify(rec);
    checksByScenario[spec.id] = checks;
    const fails = checks.filter(c => c.status === 'FAIL').length;
    const warns = checks.filter(c => c.status === 'WARN').length;
    const cost = envelope.metrics?.implementer?.costUsd ?? 0;
    const status = envelope.task?.status ?? '?';
    log(`#${spec.id}  ${spec.type}  → ${status}  $${cost.toFixed(4)}  ${fails ? `${fails} FAIL` : warns ? `${warns} WARN` : '✓'}`);
    if (spec.kind === 'write') keepWorkspaceClean(ctx.dir);
    totalCostUSD += envelope.metrics?.totalCostUsd ?? 0;
  } catch (err) {
    records.push(normalize(spec, {}));
    checksByScenario[spec.id] = [{ checkId: 'dispatch', status: 'FAIL', detail: String(err.message || err) }];
    log(`#${spec.id}  ${spec.type ?? '?'}  → DISPATCH FAILED: ${err.message}`);
  }
}

// ── Run a sequential chain of scenario ids ──
async function runChain(ids, allScenarios, ctx, log) {
  for (const id of ids) {
    const spec = allScenarios.find(s => s.id === id);
    if (!spec) continue;
    await runScenario(spec, ctx, log);
  }
}

try {
  const { dir, nonGitDir } = createProject();
  ctx.dir = dir;
  ctx.nonGitDir = nonGitDir;
  ctx.specMd = readFileSync(`${dir}/spec.md`, 'utf8');

  const log = (msg) => { process.stderr.write(msg + '\n'); };
  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.has(String(s.id))) : SCENARIOS;

  if (opts.sequential) {
    // Legacy sequential mode
    log(`Full-pipeline smoke — ${scenarios.length} scenarios (sequential)`);
    for (const spec of scenarios) await runScenario(spec, ctx, log);
  } else {
    // ── Parallel phased execution ──
    //
    // Phase 1: #1 context-blocks (prerequisite for #11, #12 blockId)
    // Phase 2: 14 parallel threads (dependencies chain within a thread)
    //   Thread A: #2 investigate → #16 investigate/resume  (session reuse needs #2)
    //   Thread B: #3 research
    //   Thread C: #4 audit/default
    //   Thread D: #5 delegate → #6 execute_plan → #9 journal_record → #10 journal_recall
    //   Thread E: #7 review
    //   Thread F: #8 debug
    //   Thread G: #11 audit/spec
    //   Thread H: #12 audit/plan
    //   Thread I: #13 audit/skill
    //   Thread J: #14 delegate/complex → #15 delegate/none → #20 sandbox-escape → #21 sandbox-cd
    //   Thread K: #17 error/invalid
    //   Thread L: #18 error/missing
    //   Thread M: #19 orchestrate
    //   Thread N: #22 audit/read-only-sandbox

    const phase2Threads = [
      [2, 16],       // investigate → session reuse
      [3],           // research
      [4, 26],       // audit/default → delta round 2
      [5, 6, 9, 10], // write chain → journal_recall
      [7],           // review
      [8],           // debug
      [11],          // audit/spec
      [12],          // audit/plan
      [13],          // audit/skill
      [14, 15, 20, 21], // write chain → sandbox tests
      [17],          // error/invalid
      [18],          // error/missing
      [19],          // orchestrate
      [22],          // audit/read-only-sandbox
      [23],          // execute_plan with uncommitted plan file
      [24],          // spec task type
      [25],          // plan task type
      [27],          // error: too many context blocks
      [28],          // delegate in non-git cwd
      [29],          // spec with a components subset (canonical reorder)
      [30],          // error: unknown component label → 400
    ];

    // Filter threads if --only is active
    const filterThread = (thread) => {
      if (!opts.only) return thread;
      return thread.filter(id => opts.only.has(String(id)));
    };

    const totalCount = 1 + phase2Threads.reduce((n, t) => n + filterThread(t).length, 0);
    log(`Full-pipeline smoke — ${totalCount} scenarios (2 phases, parallel)`);

    // Phase 1: context-blocks
    const phase1 = scenarios.find(s => s.id === 1);
    if (phase1 && (!opts.only || opts.only.has('1'))) {
      log('\n── Phase 1 (1 task) ──');
      await runScenario(phase1, ctx, log);
    }

    // Phase 2: parallel threads
    const p2Threads = phase2Threads
      .map(filterThread)
      .filter(t => t.length > 0);
    if (p2Threads.length > 0) {
      log(`\n── Phase 2 (${p2Threads.length} parallel threads, ${p2Threads.reduce((n, t) => n + t.length, 0)} tasks) ──`);
      await Promise.all(p2Threads.map(thread => runChain(thread, scenarios, ctx, log)));
    }

  }

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
