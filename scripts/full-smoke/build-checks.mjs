// Build + packaging validation phase for the full smoke.
//
// The 15 runtime scenarios verify the LIVE server (routes, workers, telemetry,
// DB). These checks verify the things a running server can't show — the Bun
// toolchain and the standalone-binary distribution:
//   - build + typecheck are clean
//   - embedded-skills.ts is in sync with src/skills (the compiled-binary asset map)
//   - the per-file test suite passes (no cross-file contamination escapes)
//   - the host binary compiles, runs, and can install skills (with @include
//     expansion) from its EMBEDDED assets — i.e. no dependence on dist/skills
//   - the bin resolver resolves the platform package and execs the binary
//
// Pure Node/Bun child_process; no server required. Returns check records in the
// same shape verify.mjs produces: [{ checkId, status: 'PASS'|'FAIL'|'SKIP', detail }].
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUN = process.env.BUN_BIN || 'bun';

function run(cmd, args, { cwd = ROOT, env = {}, timeoutMs = 600000 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, timeout: timeoutMs, encoding: 'utf8',
    env: { ...process.env, MMAGENT_AUTH_TOKEN: undefined, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error };
}

function check(checkId, status, detail) { return { checkId, status, detail }; }

// Map this host to its bun --compile target + platform package name.
function hostTarget() {
  const arch = process.arch; // x64 | arm64
  const os = process.platform === 'win32' ? 'windows' : process.platform; // darwin | linux | windows
  // (musl detection omitted for the host smoke — CI matrix covers Alpine)
  return { target: `bun-${os}-${arch}`, os, arch, binFile: os === 'windows' ? 'mmagent.exe' : 'mmagent', pkg: `@zhixuan92/mmagent-${os}-${arch}` };
}

export async function runBuildChecks(opts = {}) {
  const checks = [];
  if (opts.skipBuild) return [check('build-phase', 'SKIP', '--skip-build')];

  // 1. build (gen-embedded-skills + tsc workspaces)
  const build = run(BUN, ['run', 'build']);
  const buildErrs = (build.out.match(/error TS/g) || []).length;
  checks.push(check('build', build.code === 0 && buildErrs === 0 ? 'PASS' : 'FAIL', `exit=${build.code} tsErrors=${buildErrs}`));

  // 2. typecheck (tsc --noEmit both packages)
  const tc = run(BUN, ['run', 'typecheck']);
  const tcErrs = (tc.out.match(/error TS/g) || []).length;
  checks.push(check('typecheck', tc.code === 0 && tcErrs === 0 ? 'PASS' : 'FAIL', `exit=${tc.code} tsErrors=${tcErrs}`));

  // 3. embedded-skills.ts in sync with src/skills (regen → must be a no-op diff)
  run(BUN, ['scripts/gen-embedded-skills.mjs']);
  const diff = run('git', ['diff', '--quiet', 'packages/server/src/skill-install/embedded-skills.ts']);
  checks.push(check('embedded-skills-sync', diff.code === 0 ? 'PASS' : 'FAIL',
    diff.code === 0 ? 'embedded-skills.ts matches src/skills' : 'STALE — run gen-embedded-skills + rebuild'));

  // 4. per-file test suite (no contamination escapes; mirrors `npm test`)
  if (!opts.skipTests) {
    const tests = run(BUN, ['run', 'test'], { timeoutMs: 900000 });
    const m = tests.out.match(/all (\d+) test files passed/);
    checks.push(check('test-suite', tests.code === 0 && m ? 'PASS' : 'FAIL',
      m ? `${m[1]} files passed` : `exit=${tests.code} — ${(tests.out.match(/\d+\/\d+ file\(s\) failed/) || ['failures'])[0]}`));
  } else {
    checks.push(check('test-suite', 'SKIP', '--skip-tests'));
  }

  // 5. compile host + (when Docker is available) linux binaries for real cross-platform
  //    EXECUTION proof. On Apple Silicon, Docker runs linux/arm64 natively, so the
  //    linux glibc + musl binaries can actually be RUN, not just compiled.
  const { target, binFile } = hostTarget();
  const dockerAvail = !opts.skipDocker && run('docker', ['info'], { timeoutMs: 15000 }).code === 0;
  const linuxArch = process.arch === 'arm64' ? 'arm64' : 'x64'; // run the host-arch linux binary natively in Docker
  const linuxTargets = dockerAvail ? [`bun-linux-${linuxArch}`, `bun-linux-${linuxArch}-musl`] : [];
  const compTargets = [target, ...linuxTargets];
  const comp = run(BUN, ['scripts/build-binaries.mjs', ...compTargets], { timeoutMs: 900000 });
  const binDir = join(ROOT, 'binaries', target);
  const binPath = join(binDir, binFile);
  const compiled = comp.code === 0 && existsSync(binPath);
  checks.push(check('binary-compile', compiled ? 'PASS' : 'FAIL', `${compTargets.join(',')} exit=${comp.code}`));

  if (compiled) {
    // 6. host binary runs (entry detection via import.meta.main; --version is server-independent)
    const ver = run(binPath, ['--version'], { timeoutMs: 30000 });
    checks.push(check('binary-runs', ver.code === 0 && /\d+\.\d+\.\d+/.test(ver.out) ? 'PASS' : 'FAIL', `--version='${ver.out.trim()}' exit=${ver.code}`));

    // 7. binary installs skills from EMBEDDED assets (clean HOME) with @include expansion
    const home = mkdtempSync(join(tmpdir(), 'smoke-skill-'));
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      const sync = run(binPath, ['sync-skills', '--silent', '--best-effort'], { env: { HOME: home }, timeoutMs: 60000 });
      const installed = run('find', [home, '-name', 'SKILL.md']).out.trim().split('\n').filter(Boolean);
      let expanded = false;
      if (installed[0]) expanded = !readFileSync(installed[0], 'utf8').includes('@include');
      const ok = sync.code === 0 && installed.length > 0 && expanded;
      checks.push(check('binary-embedded-skills', ok ? 'PASS' : 'FAIL', `installed=${installed.length} includeExpanded=${expanded}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    // 8. REAL publish-shape install: npm pack the top-level + host platform package,
    //    install both into a clean dir (no repo), and run the installed bin shim →
    //    proves the bin resolver resolves the optional-dep package and execs the binary.
    const work = mkdtempSync(join(tmpdir(), 'smoke-npm-'));
    try {
      const tlDir = join(ROOT, 'binaries', '_toplevel');
      const packTl = run('npm', ['pack', '--silent', '--pack-destination', work], { cwd: tlDir });
      const packPlat = run('npm', ['pack', '--silent', '--pack-destination', work], { cwd: binDir });
      const tgzs = run('ls', [work]).out.trim().split('\n').filter((f) => f.endsWith('.tgz')).map((f) => join(work, f));
      const inst = join(work, 'install');
      mkdirSync(inst);
      run('npm', ['init', '-y'], { cwd: inst });
      const install = run('npm', ['install', '--no-audit', '--no-fund', '--no-save', ...tgzs], { cwd: inst, timeoutMs: 180000 });
      const installedBin = join(inst, 'node_modules', '.bin', 'mmagent');
      const binRun = existsSync(installedBin) ? run(installedBin, ['--version'], { cwd: inst, timeoutMs: 30000 }) : { code: 1, out: 'bin not linked' };
      const ok = packTl.code === 0 && packPlat.code === 0 && install.code === 0 && /\d+\.\d+\.\d+/.test(binRun.out);
      checks.push(check('npm-install-publish-shape', ok ? 'PASS' : 'FAIL',
        `pack/install/run -> '${binRun.out.trim()}' (install exit=${install.code})`));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }

    // 9. FOREIGN-PLATFORM EXECUTION: run the linux binaries in Docker (glibc + musl).
    //    Images mirror the realistic npm-consumer environment: a Bun --compile
    //    binary links libstdc++/libgcc even on musl, so bare `alpine` fails — but
    //    any Alpine box that has npm (node:alpine) ships those libs. We test the
    //    images consumers actually have.
    if (dockerAvail) {
      for (const [t, image, label] of [
        [`bun-linux-${linuxArch}`, 'debian:stable-slim', 'linux-glibc'],
        [`bun-linux-${linuxArch}-musl`, 'node:lts-alpine', 'linux-musl'],
      ]) {
        const lbin = join(ROOT, 'binaries', t, 'mmagent');
        if (!existsSync(lbin)) { checks.push(check(`${label}-exec`, 'FAIL', `${t} binary missing`)); continue; }
        const d = run('docker', [
          'run', '--rm', '--platform', `linux/${linuxArch}`,
          '-v', `${lbin}:/mmagent:ro`, image, '/mmagent', '--version',
        ], { timeoutMs: 300000 });
        checks.push(check(`${label}-exec`, d.code === 0 && /\d+\.\d+\.\d+/.test(d.out) ? 'PASS' : 'FAIL',
          `${image} ${linuxArch} -> '${d.out.trim().slice(0, 20)}' exit=${d.code}`));
      }
    } else {
      checks.push(check('linux-binary-exec', 'SKIP', 'docker unavailable (CI runners cover linux/windows execution)'));
    }
    // Windows binaries compile but can't execute on this OS — explicitly noted, not silently dropped.
    checks.push(check('windows-binary-exec', 'SKIP', 'cannot execute win32 binary on this OS — CI-only'));
  } else {
    for (const id of ['binary-runs', 'binary-embedded-skills', 'npm-install-publish-shape', 'linux-binary-exec', 'windows-binary-exec']) {
      checks.push(check(id, 'SKIP', 'compile failed'));
    }
  }

  // Clean up build artifacts (gitignored, but keep the tree tidy).
  try { rmSync(join(ROOT, 'binaries'), { recursive: true, force: true }); } catch { /* ignore */ }

  return checks;
}
