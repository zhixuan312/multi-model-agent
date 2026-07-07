import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const SENTINEL = 'SMOKE-REQ-7f3a2c'; // unique string asserted in dispatch #4

export function createProject() {
  const dir = mkdtempSync(join(tmpdir(), 'mma-fullsmoke-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 's@s'); git('config', 'user.name', 's');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;\n' +
    'export const multiply = (a: number, b: number) => a * b;\n' +
    'export const divide = (a: number, b: number) => a / b; // no b===0 guard\n');
  writeFileSync(join(dir, 'plan.md'),
    '# Plan\n\n### Task 1: add subtract\nAdd `subtract(a,b)` to `src/math.ts`.\n');
  writeFileSync(join(dir, 'spec.md'),
    `# Spec\n\nRequirement ${SENTINEL}: every arithmetic function must guard invalid inputs (e.g. division by zero).\n`);
  git('add', '.'); git('commit', '-qm', 'seed');

  // Write an UNCOMMITTED plan file for scenario #23 (worktree copy test)
  writeFileSync(join(dir, 'uncommitted-plan.md'),
    '# Uncommitted Plan\n\n### Task 1: add modulo\nAdd `modulo(a,b)` to `src/math.ts` that returns `a % b`.\n');
  // Intentionally NOT git-added — tests the copyToWorktree mechanism

  // Write a structured design decisions file for scenario #24 (spec task type)
  // Uses the 8-component Forge-compatible heading standard
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

  // Non-git directory for scenario #28 (delegate without worktree)
  const nonGitDir = mkdtempSync(join(tmpdir(), 'mma-nongit-'));
  mkdirSync(join(nonGitDir, 'src'));
  writeFileSync(join(nonGitDir, 'src', 'hello.ts'), 'export const hello = "world";\n');

  return { dir, nonGitDir };
}

export function destroyProject(dir, nonGitDir) {
  if (dir && dir.includes('mma-fullsmoke-')) rmSync(dir, { recursive: true, force: true });
  if (nonGitDir && nonGitDir.includes('mma-nongit-')) rmSync(nonGitDir, { recursive: true, force: true });
}
