import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['packages/server/src/skills', 'plugin/skills', 'plugin/commands', 'tests/contract/goldens', 'tests/contract/mcp'];
const stale = [/POST \/task\b/, /GET \/task\b/, /DELETE \/task\b/, /\bmma_task_(get|wait|cancel|list)\b/, /\bpoll\.taskId\b/, /\btaskId\b/, /"task"\s*:\s*\{/];
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}

describe('packaged execution vocabulary', () => {
  it('has no stale execution route or tool reference in the required trees', () => {
    const matches = roots.flatMap((root) => files(root).flatMap((file) => stale.some((pattern) => pattern.test(readFileSync(file, 'utf8'))) ? [file] : []));
    expect(matches).toEqual([]);
  });
  it('keeps the packaged flow skill and its generated plugin command aligned on Record Integration', () => {
    for (const file of ['packages/server/src/skills/mma-flow/SKILL.md', 'plugin/commands/flow.md']) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('Record Integration');
      expect(text).toMatch(/D1\/D3[\s\S]*B2[\s\S]*B5[\s\S]*B6\/B7[\s\S]*B10/);
      expect(text).toContain('.mma/verifications');
      expect(text).toMatch(/supplement/i);
    }
  });
});