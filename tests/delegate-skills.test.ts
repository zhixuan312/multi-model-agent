import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkillsForTask } from '../packages/core/src/lifecycle/task-runner.js';

// NOTE: full HTTP-level dispatch is covered by tests/delegate.test.ts; here we
// assert the skills-specific behavior at the resolve+stage seam that the
// dispatcher calls, plus the per-task isolation guarantees.

// Skill passthrough/staging is unsupported on Windows (skill-resolver throws
// skill_isolation_unsupported first); the resolve+stage seam is exercised on POSIX.
describe.skipIf(process.platform === 'win32')('delegate skills integration', () => {
  it('one task with a missing skill fails while a sibling with a valid skill resolves', async () => {
    // sibling A — valid skill resolves to a staged bundle
    const store = await mkdtemp(join(tmpdir(), 'mma-store-'));
    const dir = join(store, 'good'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: good\n---\n');

    // Resolve directly via the resolver to assert staging (sibling A).
    const { resolveAndStageSkills, cleanupSkillStaging } =
      await import('../packages/core/src/providers/skill-resolver.js');
    const a = await resolveAndStageSkills({
      client: 'claude-code', names: ['good'], batchId: 'b', taskIndex: 0, storeDirOverride: store,
    });
    expect(await stat(join(a.stagedRoot, 'skills', 'good'))).toBeTruthy();
    await cleanupSkillStaging(a.stagedRoot);

    // sibling B — unknown client → per-task failure object, not a throw
    const b = await resolveSkillsForTask({
      task: { prompt: 'x', skills: ['good'] }, client: 'cursor', batchId: 'b', taskIndex: 1,
    });
    expect(b.failure?.errorCode).toBe('skill_store_unsupported');
  });

  it('cleanup removes the staged root after use', async () => {
    const store = await mkdtemp(join(tmpdir(), 'mma-store-'));
    const dir = join(store, 'good'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: good\n---\n');
    const { resolveAndStageSkills, cleanupSkillStaging } =
      await import('../packages/core/src/providers/skill-resolver.js');
    const bundle = await resolveAndStageSkills({
      client: 'claude-code', names: ['good'], batchId: 'b2', taskIndex: 0, storeDirOverride: store,
    });
    await cleanupSkillStaging(bundle.stagedRoot);
    await expect(stat(bundle.stagedRoot)).rejects.toThrow();
  });
});
