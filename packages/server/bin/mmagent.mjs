#!/usr/bin/env node
// Top-level bin shim: resolve the installed per-platform binary package and exec it.
// The platform binary embeds the Bun runtime + app + skills, so the consumer needs
// neither Node nor Bun to RUN mmagent (Node is only present here because npm uses it).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// libc detection for linux (glibc vs musl).
function linuxLibc() {
  try {
    const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    const glibc = report?.header?.glibcVersionRuntime;
    return glibc ? 'glibc' : 'musl';
  } catch { return 'glibc'; }
}

const { platform, arch } = process;
const os = platform === 'win32' ? 'windows' : platform; // darwin | linux | windows
let target = `bun-${os}-${arch}`;
if (os === 'linux' && linuxLibc() === 'musl') target += '-musl';

const pkg = `@zhixuan92/mmagent-${os}-${arch}${os === 'linux' && linuxLibc() === 'musl' ? '-musl' : ''}`;
const binFile = os === 'windows' ? 'mmagent.exe' : 'mmagent';

let binPath;
try {
  binPath = require.resolve(`${pkg}/${binFile}`);
} catch {
  process.stderr.write(
    `mmagent: no prebuilt binary for ${target}. Your platform may be unsupported ` +
    `(64-bit darwin/linux/windows only). Install Bun and run from source as a fallback.\n`,
  );
  process.exit(1);
}

const res = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
process.exit(res.status ?? 1);
