import { execFileSync } from 'node:child_process';
import { destroyProject } from './fixtures.mjs';
import { deleteContextBlock } from './http.mjs';

const UUID = /^[0-9a-f-]{36}$/i;

export async function teardown(ctx) {
  const errors = [];
  try { destroyProject(ctx.dir, ctx.nonGitDir, ctx.writeRepos); } catch (e) { errors.push(`repo: ${e.message || e}`); }
  for (const id of ctx.contextBlockIds ?? []) {
    try { await deleteContextBlock(ctx.token, id, ctx.dir); } catch (e) { errors.push(`block ${id}: ${e.message || e}`); }
  }
  if (ctx.databaseUrl) {
    const ids = (ctx.allEventIds || []).filter((e) => UUID.test(e));
    if (ctx.dbApproved && ids.length) {
      // Precise + safe: delete only THIS run's rows by event_id (the captured set).
      try {
        execFileSync('psql', [ctx.databaseUrl, '-c',
          `DELETE FROM events_raw WHERE event_id IN (${ids.map((e) => `'${e}'`).join(',')})`], { stdio: 'pipe' });
      } catch (e) { errors.push(`db-delete: ${e.message || e}`); }
    } else if (!ctx.dbApproved) {
      errors.push(`db-delete SKIPPED: non-local/non-approved DB — ${ids.length} run rows left in events_raw (delete by event_id manually if desired)`);
    } else {
      errors.push('db-delete SKIPPED: no captured event_ids (rows may not have flushed yet)');
    }
  }
  // Initiative records are NOT removable: the Initiative Record API exposes 26 operations and no
  // delete. Every run therefore leaves a "Smoke Initiative" in the daemon's real initiatives.db
  // (`<server.stateDir>/initiatives.db`, default ~/.mma/state). Report it in the same channel as a
  // skipped db-delete — an operator who knows can prune; silence would just let it grow.
  const leaked = ctx.createdInitiatives ?? [];
  if (leaked.length) {
    errors.push(`initiative-delete UNAVAILABLE: ${leaked.length} record(s) left in initiatives.db `
      + `(${leaked.join(', ')}) — the record API has no delete operation`);
  }
  if (errors.length) console.error('[teardown] issues:\n  ' + errors.join('\n  '));
  return errors;
}
