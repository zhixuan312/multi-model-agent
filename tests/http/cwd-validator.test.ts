import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateCwd } from '../../packages/mcp/src/http/cwd-validator.js';

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

  it('canonicalizes symlinks without rejecting', () => {
    const real = path.join(tmp, 'real');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const r = validateCwd(link);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalCwd).toBe(fs.realpathSync(real));
  });
});
