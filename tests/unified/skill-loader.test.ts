import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { loadSkill, clearSkillCache } from '../../packages/core/src/unified/skill-loader.js';
import type { TaskType } from '../../packages/core/src/unified/type-registry.js';

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
    // `as TaskType`, not `as any`. The lie has to be narrow: widening the argument to `any` would
    // also stop the compiler checking the OTHER argument and the return, so a signature change
    // would slip through here silently. Matches how type-registry.test.ts spells the same idea.
    await expect(loadSkill('nonexistent' as TaskType, SKILLS_DIR)).rejects.toThrow('Skill file missing');
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

  /**
   * `default` and an omitted subtype must be the SAME load, not two.
   *
   * `mma-audit/SKILL.md` documents `subtype: 'default'` as the general-prose auditor, and there is
   * deliberately no `implement-default.md`. Before normalising, that documented spelling attempted
   * `implement-default.md`, took the ENOENT, fell back to `implement.md`, and cached the result
   * under a SECOND key holding content identical to the first.
   */
  it("treats subtype 'default' as no subtype at all", async () => {
    clearSkillCache();
    const withDefault = await loadSkill('audit', SKILLS_DIR, 'default');
    const withNone = await loadSkill('audit', SKILLS_DIR);

    expect(withDefault.implement).toBe(withNone.implement);
    // Same OBJECT, not merely equal content — proving one cache entry served both.
    expect(withDefault).toBe(withNone);
  });
});