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
    if (ctx.dbApproved && UUID.test(ctx.installId || '') && ctx.runStartTs) {
      try {
        execFileSync('psql', [ctx.databaseUrl, '-c',
          `DELETE FROM events_raw WHERE install_id='${ctx.installId}' AND received_at >= '${ctx.runStartTs}'`], { stdio: 'pipe' });
      } catch (e) { errors.push(`db-delete: ${e.message || e}`); }
    } else {
      errors.push('db-delete SKIPPED: unresolved scope (installId/runStartTs/approved) — manual cleanup may be needed');
    }
  }
  if (errors.length) console.error('[teardown] issues:\n  ' + errors.join('\n  '));
  return errors;
}
