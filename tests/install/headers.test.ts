import { describe, it, expect } from 'vitest';
import { clientHeaders, toHeaderClientName } from '../../packages/server/src/install/headers.js';

describe('clientHeaders', () => {
  it('returns X-MMA-Client: claude-code for claude-code', () => {
    expect(clientHeaders('claude-code')).toEqual({ 'X-MMA-Client': 'claude-code' });
  });

  it('returns X-MMA-Client: cursor for cursor', () => {
    expect(clientHeaders('cursor')).toEqual({ 'X-MMA-Client': 'cursor' });
  });

  it('returns X-MMA-Client: codex-cli for codex-cli', () => {
    expect(clientHeaders('codex-cli')).toEqual({ 'X-MMA-Client': 'codex-cli' });
  });

  it('returns X-MMA-Client: gemini-cli for gemini-cli', () => {
    expect(clientHeaders('gemini-cli')).toEqual({ 'X-MMA-Client': 'gemini-cli' });
  });

  it('returns only the X-MMA-Client key', () => {
    const h = clientHeaders('claude-code');
    expect(Object.keys(h)).toEqual(['X-MMA-Client']);
  });
});

describe('toHeaderClientName', () => {
  it('maps claude-code → claude-code', () => {
    expect(toHeaderClientName('claude-code')).toBe('claude-code');
  });

  it('maps cursor → cursor', () => {
    expect(toHeaderClientName('cursor')).toBe('cursor');
  });

  it('maps codex → codex-cli', () => {
    expect(toHeaderClientName('codex')).toBe('codex-cli');
  });

  it('maps gemini → gemini-cli', () => {
    expect(toHeaderClientName('gemini')).toBe('gemini-cli');
  });
});
