import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskType } from './type-registry.js';

export interface SkillPair {
  implement: string;
  review: string;
}

const cache = new Map<string, SkillPair>();

function cacheKey(type: TaskType, subtype?: string): string {
  return subtype ? `${type}:${subtype}` : type;
}

export async function loadSkill(type: TaskType, skillsDir: string, subtype?: string): Promise<SkillPair> {
  const key = cacheKey(type, subtype);
  const cached = cache.get(key);
  if (cached) return cached;

  const dir = path.join(skillsDir, type);
  const implFile = subtype ? `implement-${subtype}.md` : 'implement.md';

  const [implement, review] = await Promise.all([
    fs.readFile(path.join(dir, implFile), 'utf-8').catch(() => {
      if (subtype) {
        return fs.readFile(path.join(dir, 'implement.md'), 'utf-8').catch(() => {
          throw new Error(`Skill file missing: ${path.join(dir, implFile)} (and no fallback implement.md)`);
        });
      }
      throw new Error(`Skill file missing: ${path.join(dir, 'implement.md')}`);
    }),
    fs.readFile(path.join(dir, 'review.md'), 'utf-8').catch(() => {
      throw new Error(`Skill file missing: ${path.join(dir, 'review.md')}`);
    }),
  ]);

  const pair: SkillPair = { implement, review };
  cache.set(key, pair);
  return pair;
}

// Test-support: clear the module-level skill cache for isolation between tests.
export function clearSkillCache(): void { cache.clear(); }
