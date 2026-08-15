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
  // `default` is the DOCUMENTED spelling of "no subtype-specific criteria" — `mma-audit/SKILL.md`
  // tells callers to send it for a general prose artifact — and there is deliberately no
  // `implement-default.md`. Normalising it to "no subtype" means the documented spelling and the
  // omitted-field spelling resolve through ONE cache key to the same file. Left as-is, the
  // documented one paid an ENOENT on every cold load, then fell back, then occupied a second cache
  // entry holding content identical to the first.
  const effective = subtype === 'default' ? undefined : subtype;
  const key = cacheKey(type, effective);
  const cached = cache.get(key);
  if (cached) return cached;

  const dir = path.join(skillsDir, type);
  const implFile = effective ? `implement-${effective}.md` : 'implement.md';

  const [implement, review] = await Promise.all([
    fs.readFile(path.join(dir, implFile), 'utf-8').catch(() => {
      if (effective) {
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
