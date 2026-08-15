import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildPlugin } from '../../../packages/server/src/plugin/build-plugin.js';

const root = join(process.cwd(), 'packages/server/src/skills');
// Matches the CURRENT route as well as the retired one. These patterns named only `/task`, which
// SPEC-003 renamed to `/execution` — so the gate that exists to stop a skill teaching an agent the
// HTTP route no longer covered the route an author would actually write. A retired spelling is
// worth keeping (it costs nothing and catches a stale copy-paste), but it cannot be the only one.
const forbidden = [
  /\bcurl\b/i,
  /POST\s+\/(task|execution)\b/i,
  /GET\s+\/(task|execution)\//i,
  /Authorization:\s*Bearer/i,
  /print-token/i,
  /port discovery/i,
];
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
        // Any mma_ tool: the old explicit list named the task_* tools SPEC-003 retired, so skills
        // calling mma_execution_* silently fell out of this rule's scope.
        if (/\bmma_[a-z_]+/.test(content)) {
          expect(content, `${file} calls an MMA tool, so it must name the mma clients recovery path`)
            .toContain('mma clients');
        } else {
          expect(content, `${file} names no MMA tool, so it must not claim a recovery path`)
            .not.toContain('mma clients');
        }
      }
    }
    // A temp dir, removed afterwards. This built into `<repo>/.mma/tmp-plugin-contract` and
    // never cleaned up — gitignored, so invisible in `git status`, but it accumulated in the
    // developer's working tree on every run. `tests/plugin/build-plugin.test.ts` has used
    // mkdtemp/rm for the same call all along.
    const output = mkdtempSync(join(tmpdir(), 'mma-plugin-contract-'));
    try {
      buildPlugin({ outDir: output, version: '5.17.0', port: 7337, skillsRoot: root });
      const router = await readFile(join(output, 'skills', 'router', 'SKILL.md'), 'utf8');
      expect(router).toContain('mma_run');
      expect(router).toContain('mma clients');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});