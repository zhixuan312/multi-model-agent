/**
 * One-time migration from ~/.multi-model-agent/context-blocks/ to
 * ~/.multi-model/context-blocks/. Runs on `mmagent serve` startup
 * before the HTTP listener binds.
 *
 * Behavior:
 * - If the old path doesn't exist → no-op.
 * - If the new path already exists (machine has run a 4.2.0+ daemon
 *   before) → no-op. We never co-mingle pre-migrated dirs into a
 *   post-migration tree.
 * - Otherwise: walk old project dirs, sort by max(mtime of any file in
 *   dir; fall back to dir mtime for empty dirs), keep `maxProjects`
 *   most recent, move them to the new path, delete the dropped ones,
 *   then remove the old root entirely.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeProjectRecencyMs } from '@zhixuan92/multi-model-agent-core/stores/context-block-project-cap';

export function migrateStorage(homeDir: string, maxProjects: number): { migrated: number; dropped: number } {
  const oldRoot = path.join(homeDir, '.multi-model-agent', 'context-blocks');
  const newRoot = path.join(homeDir, '.multi-model', 'context-blocks');

  if (!fs.existsSync(oldRoot)) return { migrated: 0, dropped: 0 };
  if (fs.existsSync(newRoot)) return { migrated: 0, dropped: 0 };

  const entries = fs.readdirSync(oldRoot, { withFileTypes: true });
  // Use the SHARED recency helper from A1.6 — keeps "what counts as recent"
  // consistent across sweep and migration. Do NOT inline a copy.
  const projects = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, mtimeMs: computeProjectRecencyMs(path.join(oldRoot, e.name)) }));

  projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = projects.slice(0, maxProjects);
  const drop = projects.slice(maxProjects);

  fs.mkdirSync(newRoot, { recursive: true });

  // Track rename failures separately so the recursive-delete at the end of
  // this function does NOT silently destroy any project that failed to move.
  // (Earlier draft of this file had a critical bug: it caught rename errors,
  // continued, then unconditionally `rmSync`-ed the entire old root — wiping
  // any kept project whose rename had failed, contradicting the "operator can
  // re-migrate manually" comment. The fix below preserves the old tree intact
  // when ANY rename fails, so manual recovery is actually possible.)
  const renameFailures: Array<{ name: string; reason: string }> = [];
  for (const p of keep) {
    try {
      fs.renameSync(path.join(oldRoot, p.name), path.join(newRoot, p.name));
    } catch (err) {
      renameFailures.push({ name: p.name, reason: (err as Error).message });
    }
  }

  // Drop the over-cap projects only — they're not staying anyway, removing
  // them is consistent with the cap policy regardless of partial-failure state.
  for (const p of drop) {
    try { fs.rmSync(path.join(oldRoot, p.name), { recursive: true, force: true }); } catch { /* skip */ }
  }

  if (renameFailures.length > 0) {
    // Partial migration: keep the old tree intact (do NOT delete the old root).
    // Operator sees the warning and can either retry the daemon or copy the
    // remaining dirs manually with `mv ~/.multi-model-agent/context-blocks/<hash> ~/.multi-model/context-blocks/`.
    console.warn(
      `[mmagent] storage migration: ${renameFailures.length} project(s) failed to move; ` +
      `~/.multi-model-agent/ left in place for manual recovery. Failures:\n` +
      renameFailures.map(f => `  - ${f.name}: ${f.reason}`).join('\n')
    );
    return { migrated: keep.length - renameFailures.length, dropped: drop.length };
  }

  // Full migration succeeded → safe to remove the old root.
  try { fs.rmSync(path.join(homeDir, '.multi-model-agent'), { recursive: true, force: true }); } catch { /* skip */ }

  return { migrated: keep.length, dropped: drop.length };
}
