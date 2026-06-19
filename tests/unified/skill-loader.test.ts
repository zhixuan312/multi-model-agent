import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { loadSkill, validateSkillsExist, clearSkillCache } from '../../packages/core/src/unified/skill-loader.js';
import { TASK_TYPES } from '../../packages/core/src/unified/type-registry.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../packages/core/src/skills');

afterEach(() => clearSkillCache());

describe('SkillLoader', () => {
  it('loads delegate skills', async () => {
    const pair = await loadSkill('delegate', SKILLS_DIR);
    expect(pair.implement).toContain('Implementer');
    expect(pair.review).toContain('Refiner');
  });

  it('loads audit skills', async () => {
    const pair = await loadSkill('audit', SKILLS_DIR);
    expect(pair.implement).toContain('Implementer');
    expect(pair.review).toContain('Refiner');
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

  it('validates all 11 types have skill files', async () => {
    await expect(validateSkillsExist(TASK_TYPES, SKILLS_DIR)).resolves.not.toThrow();
  });

  it('loads audit subtype implement-plan.md when subtype=plan', async () => {
    const pair = await loadSkill('audit', SKILLS_DIR, 'plan');
    expect(pair.implement).toContain('PLAN');
    expect(pair.review).toContain('Refiner');
  });

  it('loads audit subtype implement-spec.md when subtype=spec', async () => {
    const pair = await loadSkill('audit', SKILLS_DIR, 'spec');
    expect(pair.implement).toContain('Requirement');
  });

  it('loads audit subtype implement-skill.md when subtype=skill', async () => {
    const pair = await loadSkill('audit', SKILLS_DIR, 'skill');
    expect(pair.implement).toContain('SKILL');
  });

  it('falls back to implement.md for unknown subtype', async () => {
    const defaultPair = await loadSkill('audit', SKILLS_DIR);
    clearSkillCache();
    const unknownPair = await loadSkill('audit', SKILLS_DIR, 'nonexistent');
    expect(unknownPair.implement).toBe(defaultPair.implement);
  });

  it('caches separately per subtype', async () => {
    const defaultPair = await loadSkill('audit', SKILLS_DIR);
    const planPair = await loadSkill('audit', SKILLS_DIR, 'plan');
    expect(defaultPair.implement).not.toBe(planPair.implement);
  });
});
