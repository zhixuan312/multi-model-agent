import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the per-type skill markdown root, which lives in the core
 * package at `src/skills/`.
 *
 * The previous implementation guessed two relative paths and both missed on a
 * normal consumer install, so every route failed with `skill_load_failed`. The
 * second guess assumed the core package sits NESTED inside the server
 * package's own `node_modules`. npm and pnpm hoist it to the top level
 * instead, so that directory does not exist. The first guess then produced the
 * reported path, which is why the error named a location no install ever has.
 *
 * Node's own module resolver is the authority on where a dependency lives, so
 * this asks it rather than guessing. `import.meta.resolve` walks the same
 * `node_modules` chain an `import` would, which makes it correct for a hoisted
 * install, a nested install, a pnpm symlink farm, and a global install alike.
 *
 * The monorepo check stays FIRST and stays a path guess on purpose: in the
 * monorepo the workspace link resolves to the same package, but the sources
 * under `packages/core/src/` are the editable ones a developer expects a change
 * to take effect in.
 */
export interface SkillsDirDeps {
  /** Directory of the module doing the resolving. */
  baseDir: string;
  /** Resolves a package specifier to a file URL, as `import.meta.resolve` does. */
  resolveModule: (specifier: string) => string;
  /** Existence check, injectable so a test can describe a layout it does not have on disk. */
  exists: (p: string) => boolean;
}

/**
 * The resolver, with its three environment dependencies injected.
 *
 * Exported for testing. In the monorepo the dev branch always wins, so a test
 * that calls {@link SKILLS_DIR} directly can never exercise the installed
 * branch — which is exactly why the installed branch stayed broken through
 * several releases while every test passed.
 */
export function resolveSkillsDirWith(deps: SkillsDirDeps): string {
  const devPath = path.resolve(deps.baseDir, '..', '..', '..', '..', 'packages', 'core', 'src', 'skills');
  if (deps.exists(devPath)) return devPath;

  try {
    const entry = fileURLToPath(deps.resolveModule('@zhixuan92/multi-model-agent-core'));
    const installedPath = path.resolve(path.dirname(entry), '..', 'src', 'skills');
    if (deps.exists(installedPath)) return installedPath;
  } catch {
    // Fall through — see resolveSkillsDir.
  }

  return devPath;
}

function resolveSkillsDir(): string {
  return resolveSkillsDirWith({
    baseDir: thisDir,
    resolveModule: (specifier) => import.meta.resolve(specifier),
    exists: (p) => fs.existsSync(p),
  });
}

/** Resolved once at module load — the per-type skill markdown root. */
export const SKILLS_DIR = resolveSkillsDir();
