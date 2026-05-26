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
});
