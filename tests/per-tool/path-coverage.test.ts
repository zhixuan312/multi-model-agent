import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';

const expectedTools = ['delegate', 'execute-plan', 'audit', 'review', 'verify', 'debug', 'investigate', 'explore', 'register-context-block', 'retry'];
const presentTests = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.ts') && f !== 'path-coverage.test.ts').map(f => f.replace('.test.ts', ''));

describe('per-tool path coverage', () => {
  it('every v4.0 tool has a per-tool integration test', () => {
    for (const tool of expectedTools) {
      expect(presentTests).toContain(tool);
    }
  });
});
