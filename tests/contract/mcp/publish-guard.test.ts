import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const guardPath = join(process.cwd(), 'packages/server/scripts/assert-execution-artifact-built.mjs');

/**
 * Run the guard against a synthetic package tree so the assertions are about the guard's
 * logic, never about whatever happens to be in this checkout's real `dist/`.
 */
function runGuardAgainst(html: string | undefined): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'mma-publish-guard-'));
  const scriptsDir = join(root, 'packages', 'server', 'scripts');
  const distUiDir = join(root, 'packages', 'server', 'dist', 'ui');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(guardPath, join(scriptsDir, 'assert-execution-artifact-built.mjs'));
  if (html !== undefined) {
    mkdirSync(distUiDir, { recursive: true });
    writeFileSync(join(distUiDir, 'execution.html'), html, 'utf8');
  }
  const result = spawnSync('node', [join(scriptsDir, 'assert-execution-artifact-built.mjs')], {
    encoding: 'utf8',
  });
  rmSync(root, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr };
}

describe('contract: publication guard (assert-execution-artifact-built.mjs)', () => {
  it('exits non-zero when the artifact is absent', () => {
    const { status, stderr } = runGuardAgainst(undefined);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('missing');
  });

  it('exits non-zero when the artifact is still the unbuilt placeholder', () => {
    const { status, stderr } = runGuardAgainst('<!-- mma: execution app not built — run `npm run build` -->');
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('placeholder');
  });

  /**
   * The guard must agree with the RUNTIME LOADER about what "built" means, or it protects
   * the wrong thing. `execution-artifact.ts` treats empty content as unavailable and serves
   * the placeholder, so an empty artifact that satisfies the guard would publish and then
   * silently degrade at runtime — the exact outcome the guard exists to prevent, reached by
   * passing it. A truncated or interrupted build produces precisely this file.
   */
  it('exits non-zero for an empty artifact, matching the loader treating empty as unavailable', () => {
    const { status, stderr } = runGuardAgainst('');
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/empty|placeholder|missing/);
  });

  it('exits zero for a real, non-placeholder artifact', () => {
    const { status } = runGuardAgainst('<html><body>real bundle</body></html>');
    expect(status).toBe(0);
  });

  /**
   * A correct guard that nothing invokes protects nothing. Testing only the exit codes above
   * would leave an unwired guard passing the suite, which is the failure mode most likely to
   * survive review — the script looks done because it IS done.
   */
  it('is actually WIRED into prepublishOnly, alongside the build', () => {
    const pkg = JSON.parse(readFileSync('packages/server/package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const prepublish = pkg.scripts.prepublishOnly ?? '';
    expect(prepublish).toContain('pnpm run build');
    expect(prepublish).toContain('node scripts/assert-execution-artifact-built.mjs');
  });
});
