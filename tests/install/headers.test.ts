import { describe, it, expect } from 'vitest';
import { toHeaderClientName } from '../../packages/server/src/skill-install/skill-installer-common.js';

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
