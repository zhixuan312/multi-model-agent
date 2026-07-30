#!/usr/bin/env node
/**
 * set-version.mjs — the single entry point for bumping this repo's version.
 *
 * The version lives in four places: the root manifest, both workspace manifests, and the
 * generated Claude Code plugin manifest. Keeping four files in step by hand is a step that
 * can be half-done, and half-done is how 5.16.1 shipped with a plugin manifest still
 * declaring 5.16.0. This script makes one input produce all four, so there is no ordering
 * to remember and no subset to get wrong.
 *
 *   node scripts/set-version.mjs 5.16.2
 *
 * The plugin directory is a COMMITTED GENERATED artifact: it is regenerated here rather
 * than edited, because its content derives from the server's skills and version. Commit
 * whatever this script writes.
 *
 * Deliberately does NOT touch packages/server's `@zhixuan92/multi-model-agent-core`
 * dependency, which must stay `workspace:^` in source — pnpm rewrites it at pack time, and
 * a literal version there breaks `pnpm install`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/set-version.mjs <version>');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`error: "${version}" is not a semver version`);
  process.exit(2);
}

const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/server/package.json',
];

for (const rel of MANIFESTS) {
  const path = join(repoRoot, rel);
  const raw = readFileSync(path, 'utf8');
  const current = JSON.parse(raw).version;
  // Rewrite the version line textually so key order, indentation and the trailing
  // newline survive untouched — JSON.stringify would reformat the whole file.
  const next = raw.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(next).version !== version) {
    console.error(`error: failed to set version in ${rel}`);
    process.exit(1);
  }
  writeFileSync(path, next);
  console.log(`  ${rel}: ${current} -> ${version}`);
}

// The plugin manifest is generated from the server version, so it updates by regenerating.
console.log('  regenerating plugin/ ...');
execFileSync('pnpm', ['tsx', 'packages/server/src/cli/index.ts', 'plugin', 'build', '--out', './plugin'], {
  cwd: repoRoot,
  stdio: 'pipe',
});
const pluginVersion = JSON.parse(
  readFileSync(join(repoRoot, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
).version;
if (pluginVersion !== version) {
  console.error(`error: plugin manifest is ${pluginVersion} after regeneration, expected ${version}`);
  process.exit(1);
}
console.log(`  plugin/.claude-plugin/plugin.json: -> ${pluginVersion}`);

console.log(`\nAll four locations at ${version}. Run \`pnpm install\` to sync the lockfile, then commit.`);
