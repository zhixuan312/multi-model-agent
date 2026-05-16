import { realpathSync } from 'node:fs';
import type { TaskSpec } from '../types/task-spec.js';
import { resolveGitToplevel } from './git-toplevel.js';

export interface TaskGroup {
  key: string;
  tasks: Array<{ task: TaskSpec; originalIndex: number }>;
}

/**
 * Buckets tasks by (git toplevel of cwd) ?? realpath(cwd).
 * Tasks in the same bucket share a write surface and must run serially.
 *
 * - Memoizes resolveGitToplevel per unique cwd.
 * - Group order follows the smallest originalIndex in each group, so the
 *   group containing tasks[0] is first.
 * - Within each group, tasks appear in caller input order.
 */
export async function groupTasksByRepo(tasks: TaskSpec[]): Promise<TaskGroup[]> {
  const cwds = Array.from(new Set(tasks.map((t) => t.cwd ?? process.cwd())));
  const toplevelByCwd = new Map<string, string | null>();
  await Promise.all(
    cwds.map(async (c) => {
      toplevelByCwd.set(c, await resolveGitToplevel(c));
    }),
  );

  const realpathByCwd = new Map<string, string>();
  const realpathOf = (cwd: string): string => {
    if (realpathByCwd.has(cwd)) return realpathByCwd.get(cwd)!;
    let resolved: string;
    try {
      resolved = realpathSync(cwd);
    } catch {
      resolved = cwd; // verbatim fallback
    }
    realpathByCwd.set(cwd, resolved);
    return resolved;
  };

  const byKey = new Map<string, TaskGroup>();
  const keyOrder: string[] = []; // tracks first appearance for stable group order

  tasks.forEach((task, originalIndex) => {
    const cwd = task.cwd ?? process.cwd();
    const toplevel = toplevelByCwd.get(cwd);
    const key = toplevel ?? realpathOf(cwd);
    let group = byKey.get(key);
    if (!group) {
      group = { key, tasks: [] };
      byKey.set(key, group);
      keyOrder.push(key);
    }
    group.tasks.push({ task, originalIndex });
  });

  return keyOrder.map((k) => byKey.get(k)!);
}
