import { describe, it, expect } from 'vitest';
import { CallCache } from '../../packages/core/src/runner-shell/call-cache.js';

describe('CallCache', () => {
  it('memoizes by toolName + input', () => {
    const c = new CallCache();
    c.set('read_file', { path: 'a.txt' }, 'contents');
    expect(c.get('read_file', { path: 'a.txt' })).toBe('contents');
    expect(c.has('read_file', { path: 'b.txt' })).toBe(false);
  });

  it('returns undefined for missing entries', () => {
    const c = new CallCache();
    expect(c.get('read_file', { path: 'nope.txt' })).toBeUndefined();
    expect(c.has('read_file', { path: 'nope.txt' })).toBe(false);
  });

  it('overwrites on same key', () => {
    const c = new CallCache();
    c.set('read_file', { path: 'a.txt' }, 'first');
    c.set('read_file', { path: 'a.txt' }, 'second');
    expect(c.get('read_file', { path: 'a.txt' })).toBe('second');
  });

  it('isolates across different tool names', () => {
    const c = new CallCache();
    c.set('read_file', { path: 'a.txt' }, 'read-result');
    c.set('write_file', { path: 'a.txt' }, 'write-result');
    expect(c.get('read_file', { path: 'a.txt' })).toBe('read-result');
    expect(c.get('write_file', { path: 'a.txt' })).toBe('write-result');
  });

  it('distinguishes by input shape, not just identity', () => {
    const c = new CallCache();
    c.set('run_shell', { command: 'ls' }, { stdout: 'files' });
    expect(c.get('run_shell', { command: 'ls' })).toEqual({ stdout: 'files' });
    expect(c.has('run_shell', { command: 'pwd' })).toBe(false);
  });
});
