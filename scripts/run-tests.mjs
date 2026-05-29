#!/usr/bin/env bun
// Isolated test runner: runs each test FILE in its own bun process.
// This is the canonical test entry point (`bun run test` / `npm test`).
//
// As of the test-isolation cleanup, a bare `bun test` over the whole suite ALSO
// passes — every test was de-coupled from process-global state (no mock.module()
// on shared modules; fs / child_process / claude SDK / dispatcher injected via
// dependency-injection seams; env + fetch restored in fixtures). So this runner is
// now an OPTIMIZATION, not a correctness crutch: separate processes give bounded
// parallelism (faster) plus a hard guarantee against any future re-introduction of
// cross-file leakage — but the suite no longer DEPENDS on per-file isolation to be
// green. Keep new tests leak-free (inject deps, restore globals) so both paths stay green.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_DIR = 'tests';
const EXCLUDE_DIRS = new Set(['perf', 'setup', 'fixtures', 'helpers', 'node_modules']);
const CONCURRENCY = Number(process.env.MMA_TEST_CONCURRENCY ?? 8);

function findTestFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(e)) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findTestFiles(full));
    else if (e.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = findTestFiles(TESTS_DIR).sort();
const failures = [];
let done = 0;

async function runOne(file) {
  const proc = Bun.spawn(['bun', 'test', '--pass-with-no-tests', file], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, MMAGENT_AUTH_TOKEN: undefined },
  });
  const code = await proc.exited;
  done += 1;
  if (code !== 0) {
    failures.push(file);
    process.stderr.write(`\n[FAIL ${done}/${files.length}] ${file}\n`);
    process.stderr.write(await new Response(proc.stderr).text());
  } else {
    process.stdout.write(`\r[ok ${done}/${files.length}] ${file.padEnd(70)}`);
  }
}

// Bounded-concurrency pool.
let idx = 0;
async function worker() {
  while (idx < files.length) {
    const f = files[idx++];
    await runOne(f);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

process.stdout.write('\n');
if (failures.length > 0) {
  process.stderr.write(`\n[run-tests] ${failures.length}/${files.length} file(s) failed:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
process.stderr.write(`\n[run-tests] all ${files.length} test files passed\n`);
