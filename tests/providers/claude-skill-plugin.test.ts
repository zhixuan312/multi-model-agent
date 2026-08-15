import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClaudePluginWrapper, buildClaudeSkillOptions } from '../../packages/core/src/providers/claude-skill-plugin.js';

describe('claude skill plugin', () => {
  it('writes a .claude-plugin/plugin.json referencing each staged skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-claude-'));
    await mkdir(join(root, 'skills', 'atlassian-fetch'), { recursive: true });
    await writeClaudePluginWrapper(root, ['atlassian-fetch']);
    const manifest = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.skills).toEqual(['./skills/atlassian-fetch']);
    expect(typeof manifest.name).toBe('string');
  });

  it('buildClaudeSkillOptions returns isolated plugin + skills + empty settingSources', () => {
    const opts = buildClaudeSkillOptions('/staged/root', ['a', 'b']);
    expect(opts).toEqual({
      plugins: [{ type: 'local', path: '/staged/root' }],
      skills: ['a', 'b'],
      settingSources: [],
    });
  });

  it('always returns all three keys, so a caller cannot half-configure isolation', () => {
    // This case was titled "empty-spread when no skills (default-off contract)" and checked the
    // helper's key list — but the default-off decision is the SESSION's (it spreads `{}` when
    // there is no bundle), and the helper is never called in that case at all. That contract is
    // now asserted where it lives, in claude-session-isolation.test.ts. What IS this helper's
    // to keep: `settingSources: []` never goes missing when a bundle is passed, since plugins
    // without it would load the host's settings into the worker.
    expect(Object.keys(buildClaudeSkillOptions('/r', []))).toEqual(['plugins', 'skills', 'settingSources']);
    expect(buildClaudeSkillOptions('/r', []).settingSources).toEqual([]);
  });
});
