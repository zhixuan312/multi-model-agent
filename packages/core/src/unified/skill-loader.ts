import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskType } from './type-registry.js';

export interface SkillPair {
  implement: string;
  review: string;
}

const cache = new Map<TaskType, SkillPair>();

export async function loadSkill(type: TaskType, skillsDir: string): Promise<SkillPair> {
  const cached = cache.get(type);
  if (cached) return cached;

  const dir = path.join(skillsDir, type);
  const [implement, review] = await Promise.all([
    fs.readFile(path.join(dir, 'implement.md'), 'utf-8').catch(() => {
      throw new Error(`Skill file missing: ${path.join(dir, 'implement.md')}`);
    }),
    fs.readFile(path.join(dir, 'review.md'), 'utf-8').catch(() => {
      throw new Error(`Skill file missing: ${path.join(dir, 'review.md')}`);
    }),
  ]);

  const pair: SkillPair = { implement, review };
  cache.set(type, pair);
  return pair;
}

export async function validateSkillsExist(
  types: readonly TaskType[],
  skillsDir: string,
): Promise<void> {
  const errors: string[] = [];
  for (const type of types) {
    try { await loadSkill(type, skillsDir); }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  if (errors.length > 0) throw new Error(`Skill validation failed:\n${errors.join('\n')}`);
}

export function clearSkillCache(): void { cache.clear(); }
