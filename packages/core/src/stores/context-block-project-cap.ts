/**
 * Outer LRU sweep for the context-block project directory.
 *
 * Walks all project-hash subdirectories under `contextBlocksRoot`. If the
 * count exceeds `maxProjects`, removes (rm -rf) the oldest-mtime project
 * directories until the count is at or below cap. mtime of the project
 * directory is used as the recency signal — directory mtime updates
 * whenever a file inside is added/removed, so it tracks last activity.
 *
 * For empty project dirs (no files), the dir's own mtime is the signal,
 * which is stable from creation; they typically rank lower than active
 * projects and fall off first.
 *
 * No-op when the count is at or under cap. Synchronous (called once at
 * daemon startup, low expected cost).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Per-project recency signal — the value used to decide LRU ordering.
 * For non-empty dirs: max(mtime of any file). For empty dirs: dir mtime.
 *
 * This helper is exported so the storage migration (A1.7) can use the
 * same calculation. Without sharing, the two code paths can drift and
 * different "recent" projects survive a sweep vs a migration.
 */
export function computeProjectRecencyMs(projectDir: string): number {
  let mtimeMs = 0;
  try {
    const files = fs.readdirSync(projectDir);
    if (files.length === 0) {
      mtimeMs = fs.statSync(projectDir).mtimeMs;
    } else {
      for (const f of files) {
        try {
          const m = fs.statSync(path.join(projectDir, f)).mtimeMs;
          if (m > mtimeMs) mtimeMs = m;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return mtimeMs;
}

export function sweepProjectCap(contextBlocksRoot: string, maxProjects: number): { kept: number; evicted: number } {
  if (!fs.existsSync(contextBlocksRoot)) return { kept: 0, evicted: 0 };
  const entries = fs.readdirSync(contextBlocksRoot, { withFileTypes: true });
  const projects = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, mtimeMs: computeProjectRecencyMs(path.join(contextBlocksRoot, e.name)) }));
  if (projects.length <= maxProjects) return { kept: projects.length, evicted: 0 };
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = projects.slice(0, maxProjects);
  const drop = projects.slice(maxProjects);
  for (const p of drop) {
    try { fs.rmSync(path.join(contextBlocksRoot, p.name), { recursive: true, force: true }); } catch { /* skip */ }
  }
  return { kept: keep.length, evicted: drop.length };
}
