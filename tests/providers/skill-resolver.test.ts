import { mkdtemp, mkdir, writeFile, stat, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAndStageSkills,
  cleanupSkillStaging,
  SkillResolutionError,
} from '../../packages/core/src/providers/skill-resolver.js';

async function makeStore(skillNames: string[]): Promise<string> {
  const store = await mkdtemp(join(tmpdir(), 'mma-store-'));
  for (const n of skillNames) {
    const dir = join(store, n);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${n}\n---\nbody`);
  }
  return store;
}

describe('resolveAndStageSkills', () => {
  it('copies named skills into a staged root with skills/<name> layout', async () => {
    const store = await makeStore(['atlassian-fetch', 'other']);
    const bundle = await resolveAndStageSkills({
      client: 'claude-code', names: ['atlassian-fetch'],
      batchId: 'b1', taskIndex: 0, storeDirOverride: store,
    });
    expect(bundle.names).toEqual(['atlassian-fetch']);
    const md = await readFile(join(bundle.stagedRoot, 'skills', 'atlassian-fetch', 'SKILL.md'), 'utf8');
    expect(md).toContain('name: atlassian-fetch');
    // unlisted skill not staged
    await expect(stat(join(bundle.stagedRoot, 'skills', 'other'))).rejects.toThrow();
    await cleanupSkillStaging(bundle.stagedRoot);
    await rm(store, { recursive: true, force: true });
  });

  it('throws skill_not_found for a missing name', async () => {
    const store = await makeStore(['a']);
    await expect(resolveAndStageSkills({
      client: 'claude-code', names: ['nope'], batchId: 'b', taskIndex: 0, storeDirOverride: store,
    })).rejects.toMatchObject({ code: 'skill_not_found' });
    await rm(store, { recursive: true, force: true });
  });

  it('throws skill_store_unsupported for an unknown client', async () => {
    await expect(resolveAndStageSkills({
      client: 'cursor', names: ['a'], batchId: 'b', taskIndex: 0,
    })).rejects.toMatchObject({ code: 'skill_store_unsupported' });
  });

  it('throws skill_payload_too_large past the skill-count limit', async () => {
    const names = Array.from({ length: 21 }, (_, i) => `s${i}`);
    const store = await makeStore(names);
    await expect(resolveAndStageSkills({
      client: 'claude-code', names, batchId: 'b', taskIndex: 0, storeDirOverride: store,
    })).rejects.toMatchObject({ code: 'skill_payload_too_large' });
    await rm(store, { recursive: true, force: true });
  });

  it('SkillResolutionError carries the code', () => {
    const e = new SkillResolutionError('skill_not_found', "skill 'x' not in /store");
    expect(e.code).toBe('skill_not_found');
    expect(e.message).toContain('/store');
  });
});
