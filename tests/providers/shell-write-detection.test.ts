import { describe, it, expect } from 'vitest';
import { shellCommandWritesFs } from '../../packages/core/src/providers/runner-shell.js';

describe('shellCommandWritesFs (Gap 11)', () => {
  it('detects output redirects', () => {
    expect(shellCommandWritesFs('echo hi > out.txt')).toBe(true);
    expect(shellCommandWritesFs('echo more >> log.txt')).toBe(true);
    expect(shellCommandWritesFs('cmd &> all.log')).toBe(true);
    expect(shellCommandWritesFs('cmd >| force.txt')).toBe(true);
  });

  it('does NOT detect stderr-to-stdout merges (read-only)', () => {
    // 2>&1 is descriptor-merge, not a file write. Critical for keeping
    // false positives out of read-only test/grep pipelines.
    expect(shellCommandWritesFs('grep -r foo . 2>&1')).toBe(false);
    expect(shellCommandWritesFs('npm test 2>&1 | grep PASS')).toBe(false);
  });

  it('detects sed -i variants', () => {
    expect(shellCommandWritesFs("sed -i 's/old/new/' file.txt")).toBe(true);
    expect(shellCommandWritesFs("sed -i '' 's/old/new/' file.txt")).toBe(true); // BSD sed
    expect(shellCommandWritesFs("sed --in-place 's/x/y/' file.txt")).toBe(true);
    expect(shellCommandWritesFs("sed 's/old/new/' file.txt")).toBe(false); // no -i = stdout only
  });

  it('detects awk -i inplace', () => {
    expect(shellCommandWritesFs("awk -i inplace '{print $1}' file.txt")).toBe(true);
    expect(shellCommandWritesFs("gawk -i inplace '{print}' file.txt")).toBe(true);
    expect(shellCommandWritesFs("awk '{print $1}' file.txt")).toBe(false);
  });

  it('detects tee', () => {
    expect(shellCommandWritesFs('echo x | tee out.txt')).toBe(true);
    expect(shellCommandWritesFs('echo x | tee -a log.txt')).toBe(true);
  });

  it('detects file mutators (cp/mv/touch/rm/mkdir/chmod/chown)', () => {
    expect(shellCommandWritesFs('cp a.txt b.txt')).toBe(true);
    expect(shellCommandWritesFs('mv old.txt new.txt')).toBe(true);
    expect(shellCommandWritesFs('touch new.file')).toBe(true);
    expect(shellCommandWritesFs('rm -f garbage.txt')).toBe(true);
    expect(shellCommandWritesFs('mkdir -p deep/nest')).toBe(true);
    expect(shellCommandWritesFs('chmod 600 secret')).toBe(true);
    expect(shellCommandWritesFs('chown root:root file')).toBe(true);
  });

  it('detects git commands that modify the working tree', () => {
    expect(shellCommandWritesFs('git checkout main')).toBe(true);
    expect(shellCommandWritesFs('git reset --hard HEAD')).toBe(true);
    expect(shellCommandWritesFs('git pull origin main')).toBe(true);
    expect(shellCommandWritesFs('git apply patch.diff')).toBe(true);
    expect(shellCommandWritesFs('git restore file.ts')).toBe(true);
    expect(shellCommandWritesFs('git status')).toBe(false);
    expect(shellCommandWritesFs('git log --oneline')).toBe(false);
    expect(shellCommandWritesFs('git diff HEAD')).toBe(false);
  });

  it('detects npm/pnpm/yarn install + build commands', () => {
    expect(shellCommandWritesFs('npm install')).toBe(true);
    expect(shellCommandWritesFs('npm i lodash')).toBe(true);
    expect(shellCommandWritesFs('npm ci')).toBe(true);
    expect(shellCommandWritesFs('npm run build')).toBe(true);
    expect(shellCommandWritesFs('pnpm add react')).toBe(true);
    expect(shellCommandWritesFs('yarn upgrade')).toBe(true);
    expect(shellCommandWritesFs('npm view mypkg version')).toBe(false);
  });

  it('treats read-only commands as no-write', () => {
    expect(shellCommandWritesFs('cat file.txt')).toBe(false);
    expect(shellCommandWritesFs('grep -r foo .')).toBe(false);
    expect(shellCommandWritesFs('ls -la')).toBe(false);
    expect(shellCommandWritesFs('head -20 file.log')).toBe(false);
    expect(shellCommandWritesFs('find . -name "*.ts"')).toBe(false);
  });

  it('returns false on empty / whitespace input', () => {
    expect(shellCommandWritesFs('')).toBe(false);
    expect(shellCommandWritesFs('   ')).toBe(false);
  });
});
