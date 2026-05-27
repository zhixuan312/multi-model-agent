import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateCwd } from '../../packages/server/src/http/cwd-validator.js';

describe('validateCwd', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-test-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('accepts an existing absolute directory', () => {
    const r = validateCwd(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalCwd).toBe(fs.realpathSync(tmp));
  });

  it('rejects missing cwd', () => {
    const r = validateCwd(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_cwd');
  });

  it('rejects relative paths', () => {
    const r = validateCwd('./relative/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_cwd');
  });

  it('rejects non-existent path', () => {
    const r = validateCwd('/does/not/exist/at/all/definitely');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('cwd_not_dir');
  });

  it('rejects a file (not a directory)', () => {
    const file = path.join(tmp, 'f.txt');
    fs.writeFileSync(file, 'x');
    const r = validateCwd(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('cwd_not_dir');
  });

  it('canonicalizes symlinks without rejecting when target is within parent', () => {
    const real = path.join(tmp, 'real');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    // link → real (both inside tmp), so link IS within parent → ok
    const r = validateCwd(link);
    // Note: link points to real which IS inside tmp (the parent of link), so
    // this should be ok. However, link → real is a symlink within the same parent dir.
    // The escape check only triggers when the symlink target escapes the parent.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalCwd).toBe(fs.realpathSync(real));
  });

  it('rejects symlink that escapes its parent directory → forbidden_cwd', () => {
    // Structure: tmp/outer/  (exists)
    //            tmp/sandbox/link → ../outer  (escapes sandbox)
    const outer = path.join(tmp, 'outer');
    const sandbox = path.join(tmp, 'sandbox');
    fs.mkdirSync(outer);
    fs.mkdirSync(sandbox);
    const link = path.join(sandbox, 'escape-link');
    // The link target '../outer' is relative to sandbox, resolves to tmp/outer
    // which is OUTSIDE sandbox — this is the escape scenario.
    fs.symlinkSync('../outer', link);
    const r = validateCwd(link);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('forbidden_cwd');
    }
  });

  // A4a.1 §3a step 2: reject the stale-sibling pattern that prior Claude
  // Code test runs leave behind under /tmp/claude/G--<project>-<slug>.
  // These are real directories pointing to old, abandoned project state;
  // routing tasks at them produces confused write attribution and the
  // 'feedback_mma_worker_sandbox_topic_tracker' bug pattern.
  describe('A4a.1 stale-sibling pattern rejection', () => {
    it('rejects /tmp/claude/G--*  with forbidden_cwd', () => {
      // Build a real directory matching the pattern. /tmp on macOS resolves
      // to /private/tmp via realpath; either prefix is the stale-sibling
      // pattern. Use os.tmpdir() to find the real /tmp prefix.
      const tmpRoot = path.resolve('/tmp', 'claude');
      const stalePath = path.join(tmpRoot, `G--mma-test-${Date.now()}`);
      fs.mkdirSync(stalePath, { recursive: true });
      try {
        const r = validateCwd(stalePath);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toBe('forbidden_cwd');
          expect(r.message).toMatch(/stale[- ]sibling|G--/i);
        }
      } finally {
        fs.rmSync(stalePath, { recursive: true, force: true });
      }
    });

    it('does NOT reject paths that merely contain G-- as a substring (only PREFIX matches)', () => {
      // /home/user/G--projects is a legitimate path; only the
      // /tmp/claude/G-- and /private/tmp/claude/G-- PREFIXES are stale.
      const ok = path.join(tmp, 'project-G--something');
      fs.mkdirSync(ok);
      const r = validateCwd(ok);
      expect(r.ok).toBe(true);
    });
  });
});
