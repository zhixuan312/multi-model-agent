#!/usr/bin/env node
/**
 * postinstall.js — stable wrapper.
 *
 * Runs on every `npm install @zhixuan92/multi-model-agent`. npm always runs
 * postinstall under Node, so this script stays Node-runnable (no Bun assumed)
 * even though mmagent itself runs on Bun / a compiled binary.
 *
 * Calls `mmagent sync-skills --if-exists --silent --best-effort` so users who
 * previously installed skills get their Claude Code / Gemini / Codex / Cursor
 * copies refreshed. Exits 0 on every failure mode so npm install never breaks.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distCli = join(here, '..', 'dist', 'cli', 'index.js');
const SYNC_ARGS = ['sync-skills', '--if-exists', '--silent', '--best-effort'];

let cmd;
let args;
if (existsSync(distCli)) {
  // Source / dist layout: run the JS CLI with the current interpreter
  // (node here, or bun when invoked under bun in the dev repo).
  cmd = process.execPath;
  args = [distCli, ...SYNC_ARGS];
} else {
  // Compiled-binary layout: the platform binary package exposes the `mmagent`
  // bin; invoke it by name (resolved via the installed bin) for sync-skills.
  // If neither dist nor a binary is resolvable, do nothing (exit 0).
  const binName = process.platform === 'win32' ? 'mmagent.exe' : 'mmagent';
  cmd = binName;
  args = SYNC_ARGS;
}

const child = spawn(cmd, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', () => process.exit(0)); // best-effort: never break npm install
