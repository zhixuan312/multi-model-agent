import { describe, it, expect } from 'vitest';
import { validateVerifyCommand } from '../../../../packages/server/src/http/validation/verify-command.js';

describe('validateVerifyCommand', () => {
  it('accepts undefined / empty', () => {
    expect(validateVerifyCommand(undefined).ok).toBe(true);
    expect(validateVerifyCommand([]).ok).toBe(true);
  });
  it('accepts npm test', () => { expect(validateVerifyCommand(['npm test']).ok).toBe(true); });
  it('accepts read-only git commands', () => {
    expect(validateVerifyCommand(['git status', 'git diff --stat', 'git log -1']).ok).toBe(true);
  });
  it('rejects git commit', () => {
    const r = validateVerifyCommand(['git commit -am ok']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git commit/);
  });
  it('rejects git checkout -b (mutation)', () => {
    expect(validateVerifyCommand(['git checkout -b new-branch']).ok).toBe(false);
  });
  it('rejects git push / pull / fetch', () => {
    expect(validateVerifyCommand(['git push']).ok).toBe(false);
    expect(validateVerifyCommand(['git pull']).ok).toBe(false);
    expect(validateVerifyCommand(['git fetch']).ok).toBe(false);
  });
  it('rejects git mutations inside a chain', () => {
    expect(validateVerifyCommand(['npm test && git commit -am ok']).ok).toBe(false);
  });
  it('rejects when later entry is bad', () => {
    const r = validateVerifyCommand(['npm test', 'git reset --hard']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git reset/);
  });
  it('accepts non-git unrestricted', () => {
    expect(validateVerifyCommand(['cargo test', 'pytest -x', 'make check']).ok).toBe(true);
  });
});
