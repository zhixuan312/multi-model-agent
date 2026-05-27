#!/usr/bin/env bun
// Compiles per-platform standalone mmagent binaries via `bun build --compile`.
// Embedded skill assets (embedded-skills.ts) travel inside each binary, so the
// result needs neither Node nor Bun on the consumer machine.
//
// Run `bun scripts/gen-embedded-skills.mjs` first (the root build does this).
// Outputs to binaries/<target>/mmagent[.exe].
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'packages/server/src/cli/index.ts');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'packages/server/package.json'), 'utf8')).version;

// Map a bun --compile target to the npm package name + os/cpu/libc selectors.
function platformPackage(target) {
  // target e.g. bun-darwin-arm64 | bun-linux-x64-musl | bun-windows-x64
  const rest = target.replace(/^bun-/, '');           // darwin-arm64 | linux-x64-musl | windows-x64
  const musl = rest.endsWith('-musl');
  const core = musl ? rest.slice(0, -'-musl'.length) : rest; // darwin-arm64 | linux-x64 | windows-x64
  const [osName, cpu] = core.split('-');               // darwin|linux|windows , x64|arm64
  const npmOs = osName === 'windows' ? 'win32' : osName;
  const name = `@zhixuan92/mmagent-${osName}-${cpu}${musl ? '-musl' : ''}`;
  const binFile = osName === 'windows' ? 'mmagent.exe' : 'mmagent';
  const manifest = {
    name, version: VERSION,
    os: [npmOs], cpu: [cpu],
    ...(osName === 'linux' ? { libc: [musl ? 'musl' : 'glibc'] } : {}),
    files: [binFile],
  };
  return { name, binFile, manifest };
}

// Bun 1.3 --compile targets covering the realistic mmagent audience:
// darwin/linux/windows × x64/arm64, plus linux musl (Alpine). 64-bit only.
const TARGETS = [
  'bun-darwin-arm64', 'bun-darwin-x64',
  'bun-linux-x64', 'bun-linux-arm64',
  'bun-linux-x64-musl', 'bun-linux-arm64-musl',
  'bun-windows-x64', 'bun-windows-arm64',
];

// Allow building a subset: `bun scripts/build-binaries.mjs bun-darwin-arm64 ...`
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : TARGETS;

let failed = 0;
const built = []; // platform package names successfully compiled (for the top-level optional-deps)
for (const t of targets) {
  const { name, binFile, manifest } = platformPackage(t);
  const outDir = join(ROOT, 'binaries', t);
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, binFile);
  process.stderr.write(`\n=== compiling ${t} -> ${manifest.name} ===\n`);
  const proc = Bun.spawnSync(
    [
      'bun', 'build', '--compile', `--target=${t}`,
      // Standalone binaries carry no package.json on disk, so the runtime
      // version read fails. Bake the version in (resolveServerVersion in
      // packages/server/src/version.ts reads this define first).
      `--define=MMAGENT_VERSION=${JSON.stringify(VERSION)}`,
      ENTRY, '--outfile', outfile,
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if (proc.exitCode !== 0) {
    failed += 1;
    process.stderr.write(`!!! compile failed for ${t} (exit ${proc.exitCode})\n`);
    continue;
  }
  // Emit the per-platform npm package manifest alongside the binary.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  built.push(name);
}

// Emit the thin top-level "publish-shape" package that consumers install:
// bin -> the node resolver shim; the platform binaries as optionalDependencies
// (npm installs only the one matching the host os/cpu/libc).
if (built.length > 0) {
  const tlDir = join(ROOT, 'binaries', '_toplevel');
  mkdirSync(join(tlDir, 'bin'), { recursive: true });
  copyFileSync(join(ROOT, 'packages/server/bin/mmagent.mjs'), join(tlDir, 'bin', 'mmagent.mjs'));
  const tl = {
    name: '@zhixuan92/multi-model-agent',
    version: VERSION,
    bin: { mmagent: 'bin/mmagent.mjs', 'multi-model-agent': 'bin/mmagent.mjs' },
    optionalDependencies: Object.fromEntries(built.map((n) => [n, VERSION])),
    files: ['bin'],
    engines: { node: '>=18' }, // the resolver shim runs under npm's node; the binary needs nothing
  };
  writeFileSync(join(tlDir, 'package.json'), JSON.stringify(tl, null, 2) + '\n');
  process.stderr.write(`\n[build-binaries] top-level publish-shape package -> binaries/_toplevel (${built.length} optionalDeps)\n`);
}

if (failed > 0) {
  process.stderr.write(`\n[build-binaries] ${failed}/${targets.length} target(s) failed\n`);
  process.exit(1);
}
process.stderr.write(`\n[build-binaries] all ${targets.length} target(s) compiled\n`);
