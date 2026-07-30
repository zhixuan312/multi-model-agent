import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const SENTINEL = 'SMOKE-REQ-7f3a2c'; // unique string asserted in dispatch #4

const BT = '`';
const F = '```';

// Build a contract-first Contract Task plan (the format execute_plan's parseContractPlan requires:
// `### Task I-N:`, multi-line **Files:** with Test:, five Contract bullets, an Acceptance tests block
// with Path/fenced-source/Run, and the frozen Implementation sentence). The acceptance test uses
// Node's built-in test runner (`node --test`) against a NEW `.mjs` file the executor creates — so it
// runs with zero deps and no TS loader, and passes once the trivial implementation exists.
function contractPlan(title, header, implPath, testPath, testSrc) {
  return [
    `# ${header}`, '',
    `> **Execution:** implement task-by-task with the mma-execute-plan worker.`, '',
    '## Phase 1 — Implement: the new function exists and its test passes', '',
    `### Task I-1: ${title}`, '',
    '**Files:**',
    `- Create: ${BT}${implPath}${BT}`,
    `- Test: ${BT}${testPath}${BT}`, '',
    `**Technical acceptance criteria** (← AC-1): ${title} — the function exists and its acceptance test passes.`, '',
    '**Contract:**',
    '- Inputs / Request: the arguments named in the test.',
    '- Outputs / Response: the value the test asserts.',
    '- Data mapping: result computed directly from the inputs.',
    '- Errors: none required.',
    '- Behavior / invariants: pure; no side effects.', '',
    // Authored in the mma-plan GENERATOR shape (bulleted `- Path:`/`- Run:`, indented fence, trailing
    // prose) — NOT the column-0 form — so the smoke exercises the format real plans actually have. The
    // validator tolerates + dedents this; testing only the column-0 form is what let B-317's malformed-
    // plan regression ship.
    '**Acceptance tests (plan-authored — the executable form of the technical AC).**',
    `- Path: ${BT}${testPath}${BT}`,
    `  ${F}js`,
    testSrc.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n'),
    `  ${F}`,
    `- Run: ${BT}node --test ${testPath}${BT}  Expected: PASS once implemented`, '',
    '**Implementation:** left to the executor — no code in the plan.', '',
  ].join('\n');
}

const subtractTest = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { subtract } from '../src/subtract.mjs';",
  "test('subtract', () => { assert.strictEqual(subtract(5, 3), 2); });",
].join('\n');

const moduloTest = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { modulo } from '../src/modulo.mjs';",
  "test('modulo', () => { assert.strictEqual(modulo(7, 3), 1); });",
].join('\n');

const greetingTest = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { GREETING } from '../src/greeting.mjs';",
  "test('greeting', () => { assert.strictEqual(GREETING, 'hi'); });",
].join('\n');

export function createProject() {
  const dir = mkdtempSync(join(tmpdir(), 'mma-fullsmoke-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 's@s'); git('config', 'user.name', 's');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;\n' +
    'export const multiply = (a: number, b: number) => a * b;\n' +
    'export const divide = (a: number, b: number) => a / b; // no b===0 guard\n');
  // Contract-first plan for execute_plan #6 (git target): create src/subtract.mjs, test runs via `node --test`.
  writeFileSync(join(dir, 'plan.md'),
    contractPlan('add subtract', 'Plan', 'src/subtract.mjs', 'tests/subtract.test.mjs', subtractTest));
  writeFileSync(join(dir, 'spec.md'),
    `# Spec\n\nRequirement ${SENTINEL}: every arithmetic function must guard invalid inputs (e.g. division by zero).\n`);
  git('add', '.'); git('commit', '-qm', 'seed');

  // UNCOMMITTED contract-first plan for scenario #23 (worktree copy test).
  writeFileSync(join(dir, 'uncommitted-plan.md'),
    contractPlan('add modulo', 'Uncommitted Plan', 'src/modulo.mjs', 'tests/modulo.test.mjs', moduloTest));
  // Intentionally NOT git-added — tests the copyToWorktree mechanism

  // Structured design decisions file for scenario #24 (spec task type).
  // Uses the 8-component heading standard.
  writeFileSync(join(dir, 'design-decisions.md'),
    '## Context\n\n### Background\nThe math module in src/math.ts provides arithmetic functions.\n\n' +
    '## Problem\n\n### Problem\nThe divide function has no zero-divisor guard.\n\n' +
    '## Goals & Requirements\n\n### Goals\n1. Guard all arithmetic functions against invalid inputs\n\n### Functional requirements\n- FR-1: divide must throw on zero divisor\n\n### Scope\n\n#### In scope\n- Input validation for divide\n\n#### Out of scope\n- New arithmetic functions\n\n### Constraints\n- No breaking changes to return types\n\n### Success metrics\n| Metric | Target |\n|---|---|\n| Zero-divisor guard | throws Error |\n\n' +
    '## Alternatives\n\n### Driving factors\n1. Explicit error handling\n2. API backward compatibility\n\n### Options\n#### Option A: throw Error (recommended)\nSimple, explicit.\n\n#### Option B: return NaN\nSilent failure.\n\n### Comparison\n| Factor | throw Error | return NaN |\n|---|---|---|\n| Explicitness | yes | no |\n| Verdict | **chosen** | rejected |\n\n' +
    '## Technical Design\n\n### Current state\ndivide(a,b) returns a/b with no guard.\n\n### Proposed design\nAdd if (b===0) throw new Error(\'Division by zero\') before return.\n\n### Impact\nNo breaking changes to callers that never pass zero.\n\n' +
    '## Testing Plan\n\n### Test strategy\nUnit test: expect(() => divide(1,0)).toThrow()\n\n' +
    '## Risks & Mitigations\n\n### Risks\n| Risk | Likelihood | Impact |\n|---|---|---|\n| Callers not catching | Low | Medium |\n\n### Mitigations\n| Risk | Mitigation |\n|---|---|\n| Callers not catching | Document the throw in JSDoc |\n\n' +
    '## User Stories & Tasks\n\n### User stories\n- [ ] AC-1: divide(1,0) throws Error\n- [ ] AC-2: divide(6,3) still returns 2\n');
  git('add', 'design-decisions.md'); git('commit', '-qm', 'add design decisions');

  // exploration.md for scenario #31 (spec grounding). Rough direction deliberately UNRESOLVED.
  writeFileSync(join(dir, 'exploration.md'),
    '# Exploration: Guarded arithmetic\n\n' +
    '## Background\nThe math module needs input validation; division by zero is currently unguarded.\n\n' +
    '## Current state\n\n### Findings — Internal (codebase)\n`divide(a,b)` in src/math.ts returns a/b with no guard.\n\n' +
    '## Rough direction\n\n### Direction 1: Throw on invalid input\nExplicit errors; callers handle.\n\n### Direction 2: Return NaN\nSilent; no throw.\n\n### Recommended next step\nGrill the error-handling decision in brainstorm.\n');
  git('add', 'exploration.md'); git('commit', '-qm', 'add exploration grounding');

  // Install a FAILING pre-commit hook AFTER the fixture's own commits. Write-route scenarios
  // (#5 delegate, #6/#23 execute_plan) then merge back THROUGH a repo that has a commit gate —
  // exactly the B-317 trigger: the engine's INTERNAL staging commit (in the worktree, to move the
  // worker's changes onto the branch) must bypass it (`git commit --no-verify`). If that regresses,
  // the staging commit aborts, the branch never advances, `merge --ff-only` says "Already up to
  // date", and the worker's output is silently dropped — caught now by files-changed + merge-landed.
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\necho "smoke pre-commit gate: blocked (B-317 regression guard)" >&2\nexit 1\n',
    { mode: 0o755 });

  // Non-git directory for the non-git in-place scenarios:
  //   #28 delegate     — edits the folder directly; the engine makes no commit
  //   #32 execute_plan — runs a contract-first plan there, likewise uncommitted
  const nonGitDir = mkdtempSync(join(tmpdir(), 'mma-nongit-'));
  mkdirSync(join(nonGitDir, 'src'));
  writeFileSync(join(nonGitDir, 'src', 'hello.ts'), 'export const hello = "world";\n');
  writeFileSync(join(nonGitDir, 'plan.md'),
    contractPlan('add greeting', 'Plan', 'src/greeting.mjs', 'tests/greeting.test.mjs', greetingTest));

  return { dir, nonGitDir };
}

export function destroyProject(dir, nonGitDir, writeRepos) {
  if (dir && dir.includes('mma-fullsmoke-')) rmSync(dir, { recursive: true, force: true });
  if (nonGitDir && nonGitDir.includes('mma-nongit-')) rmSync(nonGitDir, { recursive: true, force: true });
  for (const repo of Object.values(writeRepos ?? {})) {
    if (repo?.dir?.includes('mma-smoke-w')) rmSync(repo.dir, { recursive: true, force: true });
  }
}

/**
 * One ISOLATED git repo per write scenario, checked out on its own caller-owned branch.
 *
 * This is not an optimisation — it is required for correctness. The engine now edits the
 * submitted cwd IN PLACE and commits there, so N write scenarios sharing one repo would each
 * `git add -A` the same tree: every commit would sweep in the other scenarios' files, and
 * `output.filesChanged` (the git diff of that commit) would be meaningless. Worktrees used to
 * hide this by giving every task a private checkout.
 *
 * Giving each write scenario its own repo also mirrors the product exactly — a caller cuts a
 * branch per task — and it is what lets the write scenarios run genuinely in PARALLEL instead of
 * being chained purely to dodge index races.
 */
export function createWriteRepo(scenarioId, { dirty = false, precommitGate = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `mma-smoke-w${scenarioId}-`));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 's@s'); git('config', 'user.name', 's');

  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;\n' +
    'export const multiply = (a: number, b: number) => a * b;\n' +
    'export const divide = (a: number, b: number) => a / b; // no b===0 guard\n');
  writeFileSync(join(dir, 'spec.md'),
    `# Spec\n\nRequirement ${SENTINEL}: every arithmetic function must guard invalid inputs (e.g. division by zero).\n`);
  writeFileSync(join(dir, 'plan.md'),
    contractPlan('add subtract', 'Plan', 'src/subtract.mjs', 'tests/subtract.test.mjs', subtractTest));
  // A two-task plan for the partial-selection scenario: selecting by ID must run ONLY task I-2.
  writeFileSync(join(dir, 'two-task-plan.md'),
    contractPlan('add subtract', 'Two-task Plan', 'src/subtract.mjs', 'tests/subtract.test.mjs', subtractTest)
      + '\n' + contractPlan('add modulo', '', 'src/modulo.mjs', 'tests/modulo.test.mjs', moduloTest)
          .replace('# \n\n', '').replace('### Task I-1:', '### Task I-2:'));
  git('add', '.'); git('commit', '-qm', 'seed');

  // The caller owns the branch — exactly what /mma:flow and Forge do before dispatching.
  const branch = `mma/2026-07-31-smoke-${scenarioId}`;
  git('checkout', '-q', '-b', branch);

  // An UNCOMMITTED plan: still readable in place (no copy step exists any more), and it makes
  // the tree dirty at dispatch so `execution.dirtyAtDispatch` has something true to report.
  writeFileSync(join(dir, 'uncommitted-plan.md'),
    contractPlan('add modulo', 'Uncommitted Plan', 'src/modulo.mjs', 'tests/modulo.test.mjs', moduloTest));
  if (!dirty) { git('add', '.'); git('commit', '-qm', 'add uncommitted-plan (committed for a clean baseline)'); }

  // A failing pre-commit hook (B-317 guard). The engine's commit must bypass it
  // (`--no-verify`); if that regresses, the branch never advances and the worker's output is
  // silently dropped — caught by the commit-landed + files-changed checks.
  if (precommitGate) {
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho "smoke pre-commit gate: blocked (B-317 regression guard)" >&2\nexit 1\n',
      { mode: 0o755 });
  }

  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branches = execFileSync('git', ['-C', dir, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean).sort();
  return { dir, branch, headBefore: head, branchesBefore: branches, dirty };
}
