import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const SENTINEL = 'SMOKE-REQ-7f3a2c'; // unique string asserted in dispatch #4

// Skill-passthrough fixture (scenario 17). The live skill-resolver reads the
// main agent's store by X-MMA-Client; the smoke sends `claude-code`, so the
// store is ~/.claude/skills. We install a throwaway skill there before the run
// and remove it in teardown. Name is fixed + clearly disposable so a crashed
// run leaves an obviously-safe-to-delete dir.
export const SMOKE_SKILL_NAME = 'mma-smoke-skill';
const smokeSkillDir = () => join(homedir(), '.claude', 'skills', SMOKE_SKILL_NAME);

export function installSmokeSkill() {
  const dir = smokeSkillDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${SMOKE_SKILL_NAME}\n` +
    `description: Throwaway skill for the full-smoke skill-passthrough scenario. Safe to delete.\n---\n\n` +
    `This skill exists only to verify delegate skill passthrough. It instructs nothing; ` +
    `its mere resolvability + staging is what the smoke exercises.\n`);
  return SMOKE_SKILL_NAME;
}

export function removeSmokeSkill() {
  rmSync(smokeSkillDir(), { recursive: true, force: true });
}

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
    '# Plan\n\n### Task 1: add subtract\nAdd `subtract(a,b)` to `src/math.ts`.\n\n' +
    '### Task 2: add modulo\nAdd `modulo(a,b)` to `src/math.ts`.\n');
  writeFileSync(join(dir, 'spec.md'),
    `# Spec\n\nRequirement ${SENTINEL}: every arithmetic function must guard invalid inputs (e.g. division by zero).\n`);
  git('add', '.'); git('commit', '-qm', 'seed');
  installSmokeSkill();
  return { dir };
}

export function destroyProject(dir) {
  if (dir && dir.includes('mma-fullsmoke-')) rmSync(dir, { recursive: true, force: true });
}
