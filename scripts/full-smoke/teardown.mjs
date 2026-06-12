import { execFileSync } from 'node:child_process';
import { destroyProject } from './fixtures.mjs';
import { deleteContextBlock } from './http.mjs';

const UUID = /^[0-9a-f-]{36}$/i;

export async function teardown(ctx) {
  const errors = [];
  try { destroyProject(ctx.dir); } catch (e) { errors.push(`repo: ${e.message || e}`); }
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
  if (errors.length) console.error('[teardown] issues:\n  ' + errors.join('\n  '));
  return errors;
}
