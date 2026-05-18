import { recoverFalseNegatives, type RecoverSummary } from '../recovery/recover-false-negatives.js';

interface Flags {
  since?: string;
  dbUrl?: string;
  apply?: boolean;
  pageSize?: number;
  limit?: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && argv[i + 1]) { flags.since = argv[++i]; continue; }
    if (a === '--db-url' && argv[i + 1]) { flags.dbUrl = argv[++i]; continue; }
    if (a === '--apply') { flags.apply = true; continue; }
    if (a === '--dry-run') { flags.apply = false; continue; }
    if (a === '--page-size' && argv[i + 1]) { flags.pageSize = parseInt(argv[++i], 10); continue; }
    if (a === '--limit' && argv[i + 1]) { flags.limit = parseInt(argv[++i], 10); continue; }
  }
  return flags;
}

function printSummary(summary: RecoverSummary, applyMode: boolean): void {
  const mode = applyMode ? 'APPLY' : 'DRY-RUN';
  console.log(`\n[recover-telemetry] ${mode} complete.`);
  console.log(`  Candidates inspected: ${summary.candidates}`);
  console.log(`  ${applyMode ? 'Updated' : 'Would update'}: ${summary.updated}`);
  console.log(`  Legitimate failures (unchanged): ${summary.legitFailures}`);
  console.log(`  Skipped malformed: ${summary.skippedMalformed}`);
  if (summary.skippedMalformedIds.length > 0) {
    console.log(`    Skipped IDs (up to 50): ${summary.skippedMalformedIds.join(', ')}`);
  }
  console.log(`  Pages processed: ${summary.pagesProcessed}`);
  if (summary.pagesRolledBack > 0) {
    console.log(`  Pages rolled back: ${summary.pagesRolledBack}`);
  }
  if (!applyMode && summary.updated > 0) {
    console.log(`\n  To apply, re-run with --apply.`);
  }
}

export async function runRecoverTelemetry(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags.dbUrl) {
    console.error('ERROR: --db-url is required.');
    console.error('Usage: mmagent recover-telemetry --since YYYY-MM-DD --db-url <conn-string> [--dry-run | --apply] [--page-size N] [--limit N]');
    return 1;
  }
  if (!flags.since) {
    console.error('ERROR: --since YYYY-MM-DD is required.');
    return 1;
  }

  const summary = await recoverFalseNegatives({
    dbUrl: flags.dbUrl,
    since: flags.since,
    apply: flags.apply ?? false,  // dry-run is default
    pageSize: flags.pageSize ?? 500,
    limit: flags.limit,
  });

  printSummary(summary, flags.apply ?? false);
  return 0;
}
