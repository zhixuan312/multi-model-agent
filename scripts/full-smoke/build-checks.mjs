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
import { mkdtempSync, rmSync, mkdirSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
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

  // 5. compile the host standalone binary (+ per-platform manifest)
  const { target, binFile, pkg } = hostTarget();
  const comp = run(BUN, ['scripts/build-binaries.mjs', target], { timeoutMs: 300000 });
  const binDir = join(ROOT, 'binaries', target);
  const binPath = join(binDir, binFile);
  const compiled = comp.code === 0 && existsSync(binPath);
  checks.push(check('binary-compile', compiled ? 'PASS' : 'FAIL', `${target} exit=${comp.code} exists=${existsSync(binPath)}`));

  if (compiled) {
    // 6. binary runs a subcommand (entry detection via import.meta.main)
    const info = run(binPath, ['info'], { timeoutMs: 30000 });
    checks.push(check('binary-runs', info.code === 0 && /mmagent cli=/.test(info.out) ? 'PASS' : 'FAIL', `info exit=${info.code}`));

    // 7. binary installs skills from EMBEDDED assets (clean HOME) with @include expansion
    const home = mkdtempSync(join(tmpdir(), 'smoke-skill-'));
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      const sync = run(binPath, ['sync-skills', '--silent', '--best-effort'], { env: { HOME: home }, timeoutMs: 60000 });
      const installed = run('find', [home, '-name', 'SKILL.md']).out.trim().split('\n').filter(Boolean);
      let expanded = false;
      if (installed[0]) {
        const content = readFileSync(installed[0], 'utf8');
        expanded = !content.includes('@include'); // directives must be inlined from embedded _shared
      }
      const ok = sync.code === 0 && installed.length > 0 && expanded;
      checks.push(check('binary-embedded-skills', ok ? 'PASS' : 'FAIL',
        `installed=${installed.length} includeExpanded=${expanded}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    // 8. bin resolver resolves the platform package and execs the binary
    const nm = join(ROOT, 'node_modules', '@zhixuan92');
    const link = join(nm, pkg.split('/')[1]);
    try {
      mkdirSync(nm, { recursive: true });
      try { rmSync(link, { force: true }); } catch { /* ignore */ }
      symlinkSync(binDir, link);
      const resolved = run('node', [join(ROOT, 'packages/server/bin/mmagent.mjs'), 'info'], { timeoutMs: 30000 });
      checks.push(check('bin-resolver', resolved.code === 0 && /mmagent cli=/.test(resolved.out) ? 'PASS' : 'FAIL', `exit=${resolved.code}`));
    } finally {
      try { rmSync(link, { force: true }); } catch { /* ignore */ }
    }
  } else {
    checks.push(check('binary-runs', 'SKIP', 'compile failed'));
    checks.push(check('binary-embedded-skills', 'SKIP', 'compile failed'));
    checks.push(check('bin-resolver', 'SKIP', 'compile failed'));
  }

  // Clean up build artifacts (gitignored, but keep the tree tidy).
  try { rmSync(join(ROOT, 'binaries', target), { recursive: true, force: true }); } catch { /* ignore */ }

  return checks;
}
