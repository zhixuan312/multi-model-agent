import * as path from 'node:path';
import { resolveSkillsDirWith, SKILLS_DIR } from '../../../packages/server/src/application/skills-dir.js';

/**
 * Regression coverage for a defect that shipped through several releases.
 *
 * On a normal consumer install every route failed with `skill_load_failed`,
 * naming `node_modules/packages/core/src/skills/...` — a path no install has.
 * The resolver guessed two relative paths. The installed guess assumed the core
 * package sits nested inside the server package's own `node_modules`; npm and
 * pnpm hoist it to the top level, so that directory does not exist, and the
 * resolver fell back to the monorepo guess.
 *
 * No test caught it because in the monorepo the dev branch always wins, so
 * asserting on `SKILLS_DIR` alone can never reach the installed branch. These
 * tests inject the environment instead.
 */

/** The layout a real `npm install` produces: core HOISTED beside the server package. */
const HOISTED = {
  baseDir: '/app/node_modules/@zhixuan92/multi-model-agent/dist/application',
  coreEntry: 'file:///app/node_modules/@zhixuan92/multi-model-agent-core/dist/index.js',
  skills: '/app/node_modules/@zhixuan92/multi-model-agent-core/src/skills',
};

it('finds the skills when the core package is hoisted, which is what npm actually does', () => {
  const resolved = resolveSkillsDirWith({
    baseDir: HOISTED.baseDir,
    resolveModule: () => HOISTED.coreEntry,
    // Only the hoisted skills directory exists. The monorepo path does not.
    exists: (p) => p === HOISTED.skills,
  });
  expect(resolved).toBe(HOISTED.skills);
});

it('finds the skills when the core package is nested instead', () => {
  const nestedSkills = '/app/node_modules/@zhixuan92/multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/src/skills';
  const resolved = resolveSkillsDirWith({
    baseDir: HOISTED.baseDir,
    resolveModule: () => `file://${nestedSkills.replace('/src/skills', '/dist/index.js')}`,
    exists: (p) => p === nestedSkills,
  });
  expect(resolved).toBe(nestedSkills);
});

it('prefers the monorepo sources when they exist, so a local edit takes effect', () => {
  const devSkills = '/repo/packages/core/src/skills';
  const resolved = resolveSkillsDirWith({
    baseDir: '/repo/packages/server/src/application',
    // Would resolve to the workspace link — the dev path must win regardless.
    resolveModule: () => 'file:///repo/packages/core/dist/index.js',
    exists: () => true,
  });
  expect(resolved).toBe(devSkills);
});

it('falls back to a NAMEABLE path when the core package cannot be resolved at all', () => {
  // `not.toThrow()` alone was the whole assertion here, so returning `undefined` or `''` would
  // have passed — and the caller's failure would then be `skill_load_failed` naming nothing,
  // which is the exact shape of the defect this file exists for. What the fallback must be is a
  // path a human can act on: the monorepo guess, so the error at least says where it looked.
  const resolved = resolveSkillsDirWith({
    baseDir: HOISTED.baseDir,
    resolveModule: () => {
      throw new Error('ERR_MODULE_NOT_FOUND');
    },
    exists: () => false,
  });
  expect(resolved).toMatch(/packages[/\\]core[/\\]src[/\\]skills$/);
  expect(path.isAbsolute(resolved), 'a relative path in an error message locates nothing').toBe(true);
});

it('resolves to a real directory in whatever layout this test run is using', async () => {
  const { existsSync } = await import('node:fs');
  expect(existsSync(SKILLS_DIR)).toBe(true);
  expect(existsSync(`${SKILLS_DIR}/investigate/implement.md`)).toBe(true);
});
