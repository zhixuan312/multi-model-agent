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
        // `mma clients` is the recovery path when an MMA MCP tool is missing from
        // the session. A skill that calls no MMA tool has nothing to recover, so
        // requiring the line would force meaningless text into it. The exemption
        // is self-enforcing: it holds only while the skill names no MMA tool, so
        // adding a dispatch to an exempt skill fails here.
        if (/\bmma_(run|task_get|task_wait|task_cancel|task_list|context_block_)/.test(content)) {
          expect(content, `${file} calls an MMA tool, so it must name the mma clients recovery path`)
            .toContain('mma clients');
        } else {
          expect(content, `${file} names no MMA tool, so it must not claim a recovery path`)
            .not.toContain('mma clients');
        }
      }
    }
    const output = join(process.cwd(), '.mma', 'tmp-plugin-contract');
    buildPlugin({ outDir: output, version: '5.17.0', port: 7337, skillsRoot: root });
    expect(await readFile(join(output, 'skills', 'router', 'SKILL.md'), 'utf8')).toContain('mma_run');
    expect(await readFile(join(output, 'skills', 'router', 'SKILL.md'), 'utf8')).toContain('mma clients');
  });
});