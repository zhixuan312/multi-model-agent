#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflight, AbortError } from './preflight.mjs';

/**
 * Commit whatever an in-place artifact route (spec / plan / journal_record) left in the SHARED
 * fixture repo, so the next scenario starts from a clean tree.
 *
 * Engine-commit scenarios (delegate / execute_plan) do NOT go through here — each has its own
 * repo and the ENGINE owns its commit. Committing under them would destroy the very thing their
 * assertions measure (`dirtyAtDispatch`, and the no-op guard's "HEAD must not move").
 */
function keepWorkspaceClean(dir) {
  try {
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!dirty) return;
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    // --no-verify: the fixture installs a failing pre-commit hook (B-317 regression guard); this
    // harness cleanup commit must not be blocked by it.
    execFileSync('git', ['-C', dir, 'commit', '--no-verify', '-qm', 'smoke-harness: commit leftover uncommitted changes'], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}
import { createProject, createWriteRepo, createNonCodeProject } from './fixtures.mjs';
import { SPEC_COMPONENT_CATALOG } from '../../packages/core/dist/index.js';
import { SCENARIOS, ENGINE_COMMIT_TYPES } from './config.mjs';
import { runDispatch, pollTask, runCancelScenario, runMcpScenario, runMcpContractScenario, runMcpToolsScenario, runClientTimeoutScenario } from './dispatch.mjs';
import { collectResponse, collectDiagnostics, collectQueue, collectBackend, queueLineCount, allQueueEventIds } from './collectors.mjs';
import { normalize } from './normalize.mjs';
import { verify } from './verify.mjs';
import { report } from './report.mjs';
import { teardown } from './teardown.mjs';
import { startAvailabilityProbe } from './availability.mjs';
import { runRecordSurface } from './record-surface.mjs';

const argv = process.argv.slice(2);

/**
 * Reject an argument this harness does not understand, instead of ignoring it.
 *
 * Every value flag here is `--name=value`. Writing the space form (`--only 40`) parses as an
 * unrecognised `--only` plus a stray `40`, both silently dropped — so the run quietly becomes a
 * FULL sweep. A full sweep costs real provider spend and around twenty minutes, and the operator
 * only finds out at the end, from a report covering scenarios they did not ask for. A typo must
 * cost one line of stderr, not a full run.
 */
const VALUE_FLAGS = ['--only', '--branch', '--concurrency'];
const BOOLEAN_FLAGS = [
  // `--skip-lifecycle` is read at :79 and consumed by preflight, whose docstring tells the
  // operator to "pass --skip-lifecycle to opt out" of stopping their live daemon. It was missing
  // here, so the validator below exited 2 before the flag could ever be honoured — the escape
  // hatch was documented, parsed, and unreachable.
  '--skip-backend', '--strict', '--allow-mismatch', '--wait-flush', '--sequential',
  '--skip-lifecycle',
];
for (const [i, a] of argv.entries()) {
  if (BOOLEAN_FLAGS.includes(a)) continue;
  if (VALUE_FLAGS.some((f) => a.startsWith(`${f}=`))) continue;
  if (VALUE_FLAGS.includes(a)) {
    console.error(`full-smoke: ${a} needs its value attached: ${a}=${argv[i + 1] ?? '<value>'}`);
    process.exit(2);
  }
  console.error(`full-smoke: unknown argument "${a}"`);
  console.error(`  flags: ${BOOLEAN_FLAGS.join(' ')} ${VALUE_FLAGS.map((f) => `${f}=…`).join(' ')}`);
  process.exit(2);
}

const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const opts = {
  skipBackend: argv.includes('--skip-backend'),
  strict: argv.includes('--strict'),
  expectBranch: (argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null,
  allowMismatch: argv.includes('--allow-mismatch'),
  only: onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null,
  waitFlush: argv.includes('--wait-flush'),
  sequential: argv.includes('--sequential'),
  concurrency: Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 8,
  // The lifecycle gate STOPS AND RESTARTS the live daemon before any scenario
  // runs. That is deliberate — stop/restart are the upgrade path, and proving
  // them anywhere but the real daemon proves the code and skips the deployment.
  // Opt out when you are attached to that specific process (a debugger, a
  // profiler, a log tail you cannot lose).
  skipLifecycle: argv.includes('--skip-lifecycle'),
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
let availabilityProbe = null;
let availability = null;

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

    // Cooperative cancellation: dispatch, cancel mid-flight, walk to terminal.
    if (spec.kind === 'cancel') {
      const res = await runCancelScenario(ctx);
      const rec = normalize(spec, { response: res.envelope });
      rec.cancel = res.cancel;
      rec.pollAfterCancel = res.pollAfterCancel;
      rec.repeatCancel = res.repeatCancel;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  cancel  → ${res.envelope?.execution?.status} (${res.envelope?.error?.code})`);
      return;
    }

    // A client that abandons its request mid-flight must still be able to find the task.
    if (spec.kind === 'client-timeout') {
      const res = await runClientTimeoutScenario(ctx);
      const rec = normalize(spec, { response: res.terminal });
      rec.clientTimeout = res;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  reconcile  → taskId=${res.taskId} discoverable=${res.discovered}`);
      return;
    }

    // MCP carrying the two new request fields — the transport must honour them, not relay a task.
    if (spec.kind === 'mcp-contract') {
      const queueBefore = queueLineCount();
      const res = await runMcpContractScenario(ctx);
      const settleUntil = Date.now() + 15000;
      while (queueLineCount() <= queueBefore && Date.now() < settleUntil) await sleep(300);
      const rec = normalize(spec, { response: res.envelope, queue: collectQueue(queueBefore) });
      rec.mcpContract = res;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  mcp-contract  → taskId=${res.taskId} status=${res.envelope?.execution?.status}`);
      return;
    }

    // The remaining MCP tools, driven as a host would drive them.
    if (spec.kind === 'mcp-tools') {
      const res = await runMcpToolsScenario(ctx);
      const rec = normalize(spec, { response: res.terminal });
      rec.mcpTools = res;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  mcp-tools  → block=${res.blockId ? 'ok' : 'MISSING'} taskId=${res.taskId}`);
      return;
    }

    // MCP adapter: JSON-RPC round trip + REST cross-surface parity.
    if (spec.kind === 'mcp') {
      // The wire window is read for THIS scenario because MCP caller attribution
      // is only observable here. 6.2.0 fixed `X-MMA-Client` having no effect on
      // MCP tasks — the adapter derived `client` from the protocol's clientInfo
      // alone, so an Agent Plugins install could never be attributed. This
      // scenario declares a clientInfo name that is deliberately NOT in the
      // allowlist, so a correct daemon must fall back to the declared header
      // rather than collapsing to the anonymous `mcp`.
      const queueBefore = queueLineCount();
      const res = await runMcpScenario(ctx);
      const settleUntil = Date.now() + 15000;
      while (queueLineCount() <= queueBefore && Date.now() < settleUntil) await sleep(300);
      const rec = normalize(spec, { response: res.waitPayload, queue: collectQueue(queueBefore) });
      rec.mcp = res;
      records.push(rec);
      checksByScenario[spec.id] = verify(rec);
      log(`#${spec.id}  mcp  → taskId=${res.taskId} status=${res.waitPayload?.execution?.status}`);
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
    const { envelope, polling202, polling202Last } = await pollTask(ctx.token, res.taskId);

    if (spec.id === 2) {
      const implSessionId = envelope.execution?.sessions?.implementer;
      if (implSessionId) ctx.sessionFromScenario2 = implSessionId;
    }
    if (spec.id === 4) {
      const cb = envelope.output?.contextBlockId;
      if (cb) ctx.auditContextBlockId = cb;
      // Retain round 1's finding CLAIMS so the delta round can be checked on the property the
      // feature actually promises — that round 2 does not re-report what round 1 already said.
      // Counting round-2 findings cannot distinguish "correctly found nothing new" from "never
      // received the block", which is why that check could only ever WARN.
      const f = envelope.output?.summary?.findings;
      ctx.auditRound1Claims = Array.isArray(f) ? f.map((x) => String(x?.claim ?? '').trim()).filter(Boolean) : [];
    }

    const queue = collectQueue(queueBefore);
    const want = spec.emits ?? 0;
    const startSeen = seenIds.size;
    const settleUntil = Date.now() + 15000;
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
    if (polling202Last) rec.polling202Last = polling202Last;
    if (res.admission) rec.admission = res.admission;
    // The delta round needs round 1's claims to prove it did not simply re-report them.
    if (spec.delta) rec.round1Claims = ctx.auditRound1Claims ?? [];
    if (spec.sessionReuse && ctx.sessionFromScenario2) {
      rec.resumeSessionId = ctx.sessionFromScenario2;
    }
    records.push(rec);
    const checks = verify(rec);
    checksByScenario[spec.id] = checks;
    // ── Engine-commit assertions, per scenario, in that scenario's OWN repo ──
    //
    // The engine edits the caller's checkout in place and commits there. Three things must hold,
    // and each catches a different regression:
    //   commit-landed    — HEAD advanced AND every reported file is tracked at HEAD. Combined
    //                      with the fixture's failing pre-commit hook this is the B-317 guard:
    //                      if the engine's commit stops bypassing the hook, the branch never
    //                      advances and the worker's output is silently dropped.
    //   caller-branch    — the engine created NO branch and left the caller's branch checked
    //                      out. This is the whole point of caller-owned branches.
    //   no-worktree-dir  — no `.mma/worktrees/` was created.
    const repo = ctx.writeRepos?.[spec.id];
    if (repo && spec.kind === 'write') {
      const git = (...a) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          try { return execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim(); }
          catch { /* transient */ }
        }
        return '';
      };
      const headAfter = git('rev-parse', 'HEAD');
      const branchAfter = git('rev-parse', '--abbrev-ref', 'HEAD');
      const branchesAfter = git('branch', '--format=%(refname:short)').split('\n').map((x) => x.trim()).filter(Boolean).sort();

      if (spec.noopWrite) {
        // A task that changed nothing must NOT commit — otherwise it sweeps whatever the caller
        // had in progress into a commit (this exact accident happened during development).
        const stillDirty = git('status', '--porcelain').length > 0;
        checks.push(
          { checkId: 'noop-no-commit', status: headAfter === repo.headBefore ? 'PASS' : 'FAIL',
            detail: headAfter === repo.headBefore ? 'HEAD unchanged — no-op made no commit' : `HEAD MOVED ${repo.headBefore.slice(0,8)} → ${headAfter.slice(0,8)}: a no-op task committed the caller's tree` },
          { checkId: 'noop-preserved-wip', status: stillDirty ? 'PASS' : 'FAIL',
            detail: stillDirty ? "caller's uncommitted work left untouched" : "caller's uncommitted work disappeared" },
        );
      } else {
        const fc = rec?.response?.output?.filesChanged;
        const advanced = headAfter !== '' && headAfter !== repo.headBefore;
        if (Array.isArray(fc) && fc.length > 0) {
          const norm = (f) => (f.startsWith(repo.dir + '/') ? f.slice(repo.dir.length + 1) : f);
          const missing = fc.filter((f) => git('ls-files', '--', norm(f)) === '');
          checks.push({
            checkId: 'commit-landed',
            status: advanced && missing.length === 0 ? 'PASS' : 'FAIL',
            detail: !advanced
              ? `HEAD did not advance (${repo.headBefore.slice(0,8)}) — the engine commit never landed`
              : missing.length === 0
                ? `HEAD ${repo.headBefore.slice(0,8)} → ${headAfter.slice(0,8)}; all ${fc.length} reported file(s) tracked`
                : `${missing.length}/${fc.length} reported file(s) NOT tracked at HEAD: ${missing.map(norm).join(', ')}`,
          });
        }
      }

      const sameBranch = branchAfter === repo.branch;
      const sameBranchSet = branchesAfter.join(',') === repo.branchesBefore.join(',');
      checks.push(
        { checkId: 'caller-branch', status: sameBranch && sameBranchSet ? 'PASS' : 'FAIL',
          detail: sameBranch && sameBranchSet
            ? `still on ${repo.branch}; engine created no branch`
            : `branch=${branchAfter} (want ${repo.branch}); branches ${branchesAfter.join('|')} (want ${repo.branchesBefore.join('|')})` },
        { checkId: 'no-worktree-dir', status: !existsSync(join(repo.dir, '.mma', 'worktrees')) ? 'PASS' : 'FAIL',
          detail: !existsSync(join(repo.dir, '.mma', 'worktrees')) ? 'no .mma/worktrees created' : '.mma/worktrees EXISTS — the engine created a worktree' },
      );

      // #41/#42 select ONE task from a two-task plan. Only that task's file may exist.
      if (spec.selectById || spec.selectByHeading) {
        const selected = existsSync(join(repo.dir, 'src', 'modulo.mjs'));
        const other = existsSync(join(repo.dir, 'src', 'subtract.mjs'));
        checks.push({
          checkId: 'partial-selection',
          status: selected && !other ? 'PASS' : 'FAIL',
          detail: `I-2 implemented=${selected}, unselected I-1 implemented=${other} (want true/false)`,
        });
      }

      // #43 ordered the worker to run `git reset --hard`. The runner must refuse it, and the
      // engine must still commit the worker's file edits — workers lose nothing by losing git.
      if (spec.gitAttempt) {
        const fileMade = existsSync(join(repo.dir, 'src', 'gitguard.ts'));
        checks.push({
          checkId: 'worker-git-denied',
          status: headAfter !== repo.headBefore && fileMade ? 'PASS' : 'WARN',
          detail: `HEAD advanced=${headAfter !== repo.headBefore}, file written=${fileMade} — a reset that succeeded would have discarded the edit`,
        });
      }
    }

    // In-place artifact routes (spec, plan) write under `.mma/`, which real repos gitignore, so
    // the "did the output land" proof is the file existing ON DISK, not git tracking.
    if (spec.kind === 'write' && !ENGINE_COMMIT_TYPES.has(spec.type)
        && (spec.type === 'spec' || spec.type === 'plan')) {
      const fc = rec?.response?.output?.filesChanged;
      if (Array.isArray(fc) && fc.length > 0) {
        const landed = fc.filter((f) => existsSync(f) || existsSync(join(ctx.dir, f)));
        checks.push({
          checkId: 'artifact-on-disk',
          status: landed.length > 0 ? 'PASS' : 'FAIL',
          detail: landed.length > 0
            ? `${landed.length}/${fc.length} reported artifact(s) present on disk`
            : `NONE of the ${fc.length} reported artifact(s) exist on disk — output silently dropped: ${fc.join(', ')}`,
        });

        // Neutral component labels. The eight spec component IDENTIFIERS are unchanged and
        // still parser-matched, but three of them now render a deliverable-neutral display
        // label, so a finance report is not asked for "Technical Design". The emitted heading
        // is what a downstream parser and a human both read, so it is checked on the real
        // artifact rather than on the catalog constant — a catalog assertion would only prove
        // the constant agrees with itself.
        //
        // Scoped to full spec runs: #29 requests an explicit component SUBSET that excludes
        // these three, so requiring them there would fail a scenario that is behaving
        // correctly. Reported NA (never PASS) when no spec artifact could be read, so a
        // missing file cannot masquerade as a pass.
        // Software rigor at the ACCEPTANCE-CRITERIA level, asserted on the produced plan.
        //
        // The deliverable-neutral grammar makes the Checks section OPTIONAL, which is correct
        // for a claim no machine can settle. For CODE that permission must not become an
        // escape hatch: `method: 'software-change@1'` states that virtually every technical AC
        // admits a deterministic check, so a software plan that declares none has quietly
        // dropped the discipline the release promised to preserve. The Method's committed
        // guidance prose cannot prove that; only the emitted plan can.
        //
        // Three properties, because they fail independently: a plan can trace to spec ACs and
        // still declare no check, declare checks and trace to nothing, or do both and never
        // close with a suite-level gate.
        if (spec.type === 'plan' && spec.method === 'software-change@1') {
          const planFile = landed[0];
          let body = null;
          try { body = readFileSync(existsSync(planFile) ? planFile : join(ctx.dir, planFile), 'utf8'); } catch { /* unreadable */ }
          const hasChecks = body !== null && body.includes('Checks (plan-authored');
          const hasAcTrace = body !== null && /←\s*AC-/.test(body);
          const hasSuiteGate = body !== null && /full-suite gate/i.test(body);
          checks.push({
            checkId: 'software-plan-declares-checks',
            status: body === null ? 'NA' : (hasChecks ? 'PASS' : 'FAIL'),
            detail: body === null
              ? 'plan artifact unreadable — software rigor not verified'
              : `declaredChecks=${hasChecks} (a software plan with no declared check has dropped the AC-level check discipline)`,
          });
          checks.push({
            checkId: 'software-plan-traces-to-spec-ac',
            status: body === null ? 'NA' : (hasAcTrace ? 'PASS' : 'FAIL'),
            detail: `acTraceability=${hasAcTrace} (every task must cite the spec AC it delivers)`,
          });
          checks.push({
            checkId: 'software-plan-closes-with-suite-gate',
            status: body === null ? 'NA' : (hasSuiteGate ? 'PASS' : 'WARN'),
            detail: `fullSuiteGate=${hasSuiteGate} (per-task checks do not prove the suite still passes)`,
          });
        }

        if (spec.type === 'spec' && !spec.subsetComponents) {
          const specFile = landed[0];
          let body = null;
          try { body = readFileSync(existsSync(specFile) ? specFile : join(ctx.dir, specFile), 'utf8'); } catch { /* unreadable */ }
          // Both lists are DERIVED from the shipped catalog, never restated here (AC-5.4).
          // A hand-written copy could only agree with itself: if a display label changed, this
          // check would keep asserting the old one and pass while the product emitted the new.
          const renamed = SPEC_COMPONENT_CATALOG.filter((entry) => entry.displayLabel !== entry.id);
          const RETIRED = renamed.map((entry) => `## ${entry.id}`);
          const NEUTRAL = renamed.map((entry) => entry.displayLabel);
          const present = body === null ? [] : NEUTRAL.filter((label) => body.includes(label));
          const retired = body === null ? [] : RETIRED.filter((heading) => body.includes(heading));
          checks.push({
            checkId: 'neutral-component-labels',
            status: body === null ? 'NA' : (present.length > 0 && retired.length === 0 ? 'PASS' : 'FAIL'),
            detail: body === null
              ? 'spec artifact unreadable — label rendering not verified'
              : `neutral=[${present.join(', ')}] retiredHeadings=[${retired.join(', ')}]`,
          });
        }
      }
    }

    const fails = checks.filter(c => c.status === 'FAIL').length;
    const warns = checks.filter(c => c.status === 'WARN').length;
    const cost = envelope.metrics?.implementer?.costUsd ?? 0;
    const status = envelope.execution?.status ?? '?';
    log(`#${spec.id}  ${spec.type}  → ${status}  $${cost.toFixed(4)}  ${fails ? `${fails} FAIL` : warns ? `${warns} WARN` : '✓'}`);
    if (spec.kind === 'write' && !ctx.writeRepos?.[spec.id]) keepWorkspaceClean(ctx.dir);
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

  // One isolated repo per engine-commit scenario, each on its own caller-created branch. The
  // engine commits the submitted cwd IN PLACE, so scenarios sharing a checkout would sweep each
  // other's files into their commits — and this is also what lets them run in parallel.
  ctx.nonCodeDir = createNonCodeProject().dir;
  ctx.writeRepos = {};
  for (const spec of SCENARIOS) {
    if (!ENGINE_COMMIT_TYPES.has(spec.type) || spec.nonGitCwd) continue;
    ctx.writeRepos[spec.id] = createWriteRepo(spec.id, { dirty: spec.dirtyRepo === true });
  }
  ctx.specMd = readFileSync(`${dir}/spec.md`, 'utf8');

  const log = (msg) => { process.stderr.write(msg + '\n'); };
  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.has(String(s.id))) : SCENARIOS;

  // Continuous queue capture: the server's telemetry flusher drains the local queue file every
  // ~5 min (uploading to the backend, independent of --skip-backend). A record emitted just before
  // a flush would be gone before a per-scenario settle scan sampled it — the wire record WAS emitted,
  // the smoke just missed it. Tail the queue on a tight interval so every id is captured the instant
  // it lands, before any flush can drain it. seenIds is a Set, so this only ever adds.
  const bgScan = setInterval(() => {
    try { for (const id of allQueueEventIds()) if (!baselineIds.has(id)) seenIds.add(id); } catch { /* transient read race */ }
  }, 150);
  ctx.bgScan = bgScan;

  if (opts.sequential) {
    // Legacy sequential mode
    log(`Full-pipeline smoke — ${scenarios.length} scenarios (sequential)`);
    for (const spec of scenarios) await runScenario(spec, ctx, log);
  } else {
    // ── Parallel phased execution ──
    //
    // Phase 1: #1 context-blocks — the only true prerequisite (mints the blockId #11/#12 use).
    // Phase 2: one thread per scenario, EXCEPT where a scenario genuinely consumes a previous
    //          scenario's output. A thread is a dependency chain, not a grouping convenience.
    //
    // Only three real dependencies exist:
    //   [2, 16]  — #16 resumes the session #2 created.
    //   [4, 26]  — #26 passes the contextBlockId #4 produced.
    //   [9, 10]  — #10 recalls the journal node #9 recorded.
    //
    // Everything else runs concurrently. Write scenarios used to be chained as well, but only to
    // stop them racing the git index of one shared repo; each now gets its OWN repo on its own
    // caller-created branch (fixtures.createWriteRepo), which is both what the product actually
    // does and what makes their commits independently assertable.
    const phase2Threads = [
      [2, 16],       // investigate → session reuse            (DEPENDENCY)
      [4, 26],       // audit/default → context-block delta    (DEPENDENCY)
      [9, 10],       // journal_record → journal_recall        (DEPENDENCY)
      [3],           // research
      [5],           // delegate (reviewed)
      [6],           // execute_plan
      [7],           // review
      [8],           // debug
      [11],          // audit/spec
      [12],          // audit/plan
      [13],          // audit/skill
      [14],          // delegate @complex (tier override)
      [15],          // delegate reviewPolicy=none
      [17],          // error: invalid type
      [18],          // error: missing field
      [19],          // orchestrate
      [20],          // sandbox: cwd escape
      [21],          // sandbox: cd-chain escape
      [22],          // sandbox: read-only
      [23],          // execute_plan: uncommitted plan + dirty tree
      [24],          // spec
      [25],          // plan
      [27],          // error: too many context blocks
      [28],          // delegate in a non-git cwd (no commit)
      [29],          // spec: component subset (canonical reorder)
      [30],          // error: unknown component label
      [31],          // spec: decisions + exploration grounding
      [32],          // execute_plan in a non-git cwd (no commit)
      [33],          // error: empty target
      [34],          // spec: unresolvable path → async 6-field error envelope
      [35],          // journal_record: canonical records[] batch
      [36],          // error: journal_record mixed shape
      [37],          // error: journal_record empty records[]
      [38],          // no-op write makes NO commit (caller's WIP preserved)
      [39],          // cancellation lifecycle
      [40],          // MCP transport + REST parity
      [41],          // execute_plan: partial selection by task ID
      [42],          // execute_plan: partial selection by full heading
      [43],          // worker git denial
      [44],          // deliverable contract: valid approved contract accepted
      [45],          // execute_plan: Contract Task with NO declared check
      [46],          // plan: method=software-change@1 reaches Method resolution
      [47],          // error: contract not approved
      [48],          // error: contract digest mismatch
      [49],          // error: commit-in-place disposition in a non-git workspace
      [50],          // error: unregistered method identifier
      [51],          // execute_plan carrying BOTH deliverable and method
      [52],          // review + method
      [53],          // debug + method
      [54],          // spec + deliverable (this scenario omits method)
      [55],          // MCP transport carrying deliverable + method
      [56],          // the remaining MCP tools: list, get, cancel, context-block create/delete
      [57],          // investigate a NON-CODE workspace (documents + data, no source)
      [58],          // plan a NON-CODE deliverable (no build, no suite, no tests/)
      [59],          // a client that abandons the request must still be able to reconcile
      [60],          // POST /configure-provider — validation contract (never a live swap)
    ];

    // Coverage guard. phase2Threads is a hand-maintained schedule, so a scenario
    // added to SCENARIOS but not to a thread would simply never run — a SILENT
    // coverage hole in a release gate (exactly how #39/#40 were dropped from a
    // full sweep while passing under --only). Fail loudly instead.
    {
      const scheduled = new Set(phase2Threads.flat());
      const unscheduled = SCENARIOS
        .map((s) => s.id)
        .filter((id) => id !== 1 && !scheduled.has(id));   // #1 runs in phase 1
      if (unscheduled.length > 0) {
        console.error(`[smoke] FATAL: scenario(s) ${unscheduled.join(', ')} are in SCENARIOS but not in phase2Threads — `
          + 'they would never run. Add them to the schedule.');
        process.exit(2);
      }
      const orphaned = [...scheduled].filter((id) => !SCENARIOS.some((s) => s.id === id));
      if (orphaned.length > 0) {
        console.error(`[smoke] FATAL: phase2Threads schedules unknown scenario id(s) ${orphaned.join(', ')}.`);
        process.exit(2);
      }
    }

    // Filter threads if --only is active
    const filterThread = (thread) => {
      if (!opts.only) return thread;
      return thread.filter(id => opts.only.has(String(id)));
    };

    const totalCount = 1 + phase2Threads.reduce((n, t) => n + filterThread(t).length, 0);
    log(`Full-pipeline smoke — ${totalCount} scenarios (2 phases, parallel)`);

    // Availability, measured for the WHOLE run. Every other check in this harness measures an
    // outcome; none measured whether the daemon stayed answerable while producing it. A daemon
    // that stalls its HTTP layer still lets separate-process workers finish, so an outcome-only
    // gate reports all-green through an outage a caller would certainly notice.
    availabilityProbe = startAvailabilityProbe({ token: ctx.token });

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
      const cap = opts.sequential ? 1 : opts.concurrency;
      log(`   (concurrency cap: ${cap})`);
      let cursor = 0;
      const worker = async () => { while (cursor < p2Threads.length) { const t = p2Threads[cursor++]; await runChain(t, scenarios, ctx, log); } };
      await Promise.all(Array.from({ length: Math.min(cap, p2Threads.length) }, worker));
    }

  }

  // ── Initiative Record surface ──
  // The numeric SCENARIOS above cover the EXECUTION routes only. Everything the grand plan
  // promises about the RECORD (resume, lifecycle, methods, intake, delivery, portability) is
  // exercised here, live, against the same daemon.
  {
    log('\n── Record surface (initiatives · lifecycle · methods · delivery · portability) ──');
    const rs = await runRecordSurface(ctx, log);
    for (const rec of rs.records) records.push(rec);
    Object.assign(checksByScenario, rs.checksByScenario);
  }

  // Telemetry final settle: a short grace so trailing wire records from the last scenarios that
  // land just after their per-scenario window are still counted. The 150ms background tailer above
  // already captures continuously, so this only needs a brief top-up (records that permanently race
  // the flush/rewrite are unobservable locally by design — see report.mjs).
  {
    const finalUntil = Date.now() + 4000;
    for (;;) {
      for (const id of allQueueEventIds()) if (!baselineIds.has(id)) seenIds.add(id);
      if (seenIds.size >= expectedEmits || Date.now() >= finalUntil) break;
      await sleep(300);
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
  if (ctx.bgScan) clearInterval(ctx.bgScan);
  // Stop BEFORE teardown: teardown may stop or restart the daemon, and an outage it causes on
  // purpose is not a product defect.
  if (availabilityProbe) availability = await availabilityProbe.stop();
  await teardown(ctx);
}

const exitCode = report(records, checksByScenario, {
  serverVersion: ctx.serverVersion, bootId: ctx.bootId,
  mode: opts.skipBackend ? 'REDUCED (--skip-backend)' : 'FULL',
  strict: opts.strict, totalCostUSD,
  backend: backendSummary, queueEventCount: seenIds.size, expectedRows: expectedEmits,
  waitFlush: opts.waitFlush, dbApproved: ctx.dbApproved, availability,
});
process.exit(exitCode);
