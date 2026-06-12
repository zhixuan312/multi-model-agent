import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { loadSkill, validateSkillsExist, clearSkillCache } from '../../packages/core/src/unified/skill-loader.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../packages/core/src/skills');

afterEach(() => clearSkillCache());

describe('SkillLoader', () => {
  it('loads delegate skills', async () => {
    const pair = await loadSkill('delegate', SKILLS_DIR);
    expect(pair.implement).toContain('Implementer');
    expect(pair.review).toContain('Reviewer');
  });

  it('loads audit skills', async () => {
    const pair = await loadSkill('audit', SKILLS_DIR);
    expect(pair.implement).toContain('Implementer');
    expect(pair.review).toContain('Reviewer');
  });

  it('caches on second call', async () => {
    const a = await loadSkill('delegate', SKILLS_DIR);
    const b = await loadSkill('delegate', SKILLS_DIR);
    expect(a).toBe(b);
  });

  it('throws for missing type', async () => {
    await expect(loadSkill('nonexistent' as any, SKILLS_DIR)).rejects.toThrow('Skill file missing');
  });

  it('validateSkillsExist passes for delegate+audit', async () => {
    await expect(validateSkillsExist(['delegate', 'audit'], SKILLS_DIR)).resolves.not.toThrow();
  });
});
