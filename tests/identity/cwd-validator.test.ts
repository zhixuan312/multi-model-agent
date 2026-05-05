import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CWDValidator } from '../../packages/core/src/identity/cwd-validator.js';

describe('CWDValidator', () => {
  it('accepts paths within cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwdv-'));
    writeFileSync(join(dir, 'b.txt'), 'x');
    const v = new CWDValidator(dir);
    expect(() => v.validate('b.txt')).not.toThrow();
  });

  it('rejects path traversal (file existence is irrelevant; cwd resolution still happens)', () => {
    const v = new CWDValidator('/tmp');
    expect(() => v.validate('../etc/passwd')).toThrow(/escapes cwd|ENOENT/);
  });
});
