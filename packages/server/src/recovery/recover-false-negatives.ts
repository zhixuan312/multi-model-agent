import { Client } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCompletionFromWire } from './derive-completion-from-wire.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECT_QUERY = fs.readFileSync(path.join(__dirname, 'false-negative-query.sql'), 'utf8');

export interface RecoverOpts {
  dbUrl: string;
  since: string;             // ISO date 'YYYY-MM-DD'
  apply: boolean;            // false = dry-run (default)
  pageSize: number;          // default 500
  limit?: number;            // optional global cap (for testing)
}

export interface RecoverSummary {
  candidates: number;
  updated: number;
  legitFailures: number;
  skippedMalformed: number;
  skippedMalformedIds: number[];  // up to 50
  pagesProcessed: number;
  pagesRolledBack: number;
}

export async function recoverFalseNegatives(opts: RecoverOpts): Promise<RecoverSummary> {
  const client = new Client({ connectionString: opts.dbUrl });
  await client.connect();

  const summary: RecoverSummary = {
    candidates: 0, updated: 0, legitFailures: 0, skippedMalformed: 0,
    skippedMalformedIds: [], pagesProcessed: 0, pagesRolledBack: 0,
  };

  try {
    if (opts.apply) {
      await client.query('ALTER TABLE mma_telemetry ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ NULL;');
    }

    let offset = 0;
    while (true) {
      if (opts.limit && summary.candidates >= opts.limit) break;
      const pageLimit = Math.min(opts.pageSize, opts.limit ? opts.limit - summary.candidates : opts.pageSize);

      const result = await client.query(SELECT_QUERY, [opts.since, pageLimit, offset]);
      if (result.rows.length === 0) break;

      summary.candidates += result.rows.length;

      const updates: { id: number; terminal: string; worker: string; errorCode: string | null }[] = [];
      for (const row of result.rows) {
        const reconstruct = deriveCompletionFromWire(row.event);
        if (!reconstruct.ok) {
          summary.skippedMalformed++;
          if (summary.skippedMalformedIds.length < 50) summary.skippedMalformedIds.push(row.id);
          continue;
        }
        if (!reconstruct.result.completed) {
          summary.legitFailures++;
          continue;
        }
        // Determine done vs done_with_concerns
        const concernCount = (row.event?.concernCount ?? 0) as number;
        const hasConcerns = concernCount > 0;
        updates.push({
          id: row.id,
          terminal: 'ok',
          worker: hasConcerns ? 'done_with_concerns' : 'done',
          errorCode: null,
        });
      }

      if (opts.apply && updates.length > 0) {
        try {
          await client.query('BEGIN');
          for (const u of updates) {
            await client.query(
              'UPDATE mma_telemetry SET terminal_status=$1, worker_status=$2, error_code=$3, recovered_at=NOW() WHERE id=$4',
              [u.terminal, u.worker, u.errorCode, u.id]
            );
          }
          await client.query('COMMIT');
          summary.updated += updates.length;
          summary.pagesProcessed++;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          summary.pagesRolledBack++;
          throw new Error(`Page rollback at offset ${offset}: ${(err as Error).message}`);
        }
      } else {
        summary.updated += updates.length;  // dry-run: count as "would update"
        summary.pagesProcessed++;
      }

      offset += result.rows.length;
      if (result.rows.length < pageLimit) break;
    }
  } finally {
    await client.end();
  }

  return summary;
}
