import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlugin } from '../../../packages/server/src/plugin/build-plugin.js';

const root = join(process.cwd(), 'packages/server/src/skills');
const forbidden = [/\bcurl\b/i, /POST\s+\/task/i, /GET\s+\/task\//i, /Authorization:\s*Bearer/i, /print-token/i, /port discovery/i];
async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry);
    return (await stat(path)).isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
  }));
  return nested.flat();
}

describe('contract: MCP-only packaged client surface', () => {
  it('ships one MCP route, no HTTP fallback, and regenerated client-agnostic plugin bytes', async () => {
    const files = await markdownFiles(root);
    expect(files).not.toContain(join(root, '_shared', 'auth.md'));
    expect(files).not.toContain(join(root, '_shared', 'polling.md'));
    expect(files).not.toContain(join(root, '_shared', 'error-handling.md'));
    expect(files).not.toContain(join(root, '_shared', 'prefer-mcp.md'));
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const pattern of forbidden) expect(content, file).not.toMatch(pattern);
      expect(content, file).not.toContain('<client>');
      if (file.endsWith('/SKILL.md')) {
        const name = content.match(/^name:\s*([^\n\r]+)/m)?.[1]?.trim();
        expect(name, file).toBe(file.split('/').at(-2));
        expect(content, file).toContain('mma clients');
      }
    }
    const output = join(process.cwd(), '.mma', 'tmp-plugin-contract');
    buildPlugin({ outDir: output, version: '5.17.0', port: 7337, skillsRoot: root });
    expect(await readFile(join(output, 'skills', 'router', 'SKILL.md'), 'utf8')).toContain('mma_run');
    expect(await readFile(join(output, 'skills', 'router', 'SKILL.md'), 'utf8')).toContain('mma clients');
  });
});