#!/usr/bin/env node
/**
 * postinstall.js — stable wrapper.
 *
 * Runs on every `npm install @zhixuan92/multi-model-agent`.
 *
 * Calls `mmagent update-skills --if-exists --silent --best-effort` so that
 * users who previously installed skills get their Claude Code / Gemini /
 * Codex / Cursor copies refreshed to match this release. Exits 0 on every
 * failure mode so npm install never breaks the user's environment.
 *
 * The wrapper is committed (always present) so publishing does not
 * accidentally bundle a CLI build step that references a missing file.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli', 'index.js');

// If dist hasn't been built yet (e.g. during the repo's own install before
// build), do nothing — the published tarball always includes dist.
if (!existsSync(cli)) {
  process.exit(0);
}

const child = spawn(
  process.execPath,
  [cli, 'update-skills', '--if-exists', '--silent', '--best-effort'],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', () => process.exit(0));
