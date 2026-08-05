/**
 * `mma journal reindex` — rebuild the derived SQLite lexical index
 * (`.mma/journal/index.db`) from the authoritative markdown node files.
 *
 * The markdown nodes under `<journalRoot>/nodes/` are the single source of
 * truth; `index.db` is fully rebuildable from them. This command never mutates
 * node content.
 *
 * `ensureHealthy()` recovers a missing or schema-mismatched `index.db` before
 * `rebuildIndex()` re-derives every row (AC-5.5). Refreshing `index.db` is
 * always safe; regenerating the committed `index.md` catalog is opt-in and only
 * happens with `--regenerate-catalog`.
 */
import { resolve } from 'node:path';
import {
  JournalIndexStore,
  JournalStore,
  JOURNAL_INDEX_DB_FILENAME,
} from '@zhixuan92/multi-model-agent-core';

interface JournalReindexOptions {
  /** Working directory whose `.mma/journal` is reindexed. */
  cwd: string;
  /** When true, also regenerate the committed `index.md` catalog from node state. */
  regenerateCatalog: boolean;
  /** stdout sink. */
  stdout: (line: string) => boolean;
  /** stderr sink. */
  stderr?: (line: string) => boolean;
}

export async function runJournalReindex(opts: JournalReindexOptions): Promise<number> {
  const journalRoot = resolve(opts.cwd, '.mma', 'journal');
  const dbPath = resolve(journalRoot, JOURNAL_INDEX_DB_FILENAME);

  const store = await JournalIndexStore.open({ journalRoot });
  try {
    // Recover a missing/corrupt index.db, then fully re-derive from node files.
    await store.ensureHealthy();
    await store.rebuildIndex();
    const nodeCount = store.allDocuments().length;

    let catalogNote = '';
    if (opts.regenerateCatalog) {
      const journalStore = await JournalStore.open({ journalRoot });
      const catalogNodes = await journalStore.rebuildCatalog();
      catalogNote = `; regenerated index.md (${catalogNodes} nodes)`;
    }

    opts.stdout(`Rebuilt ${dbPath} (${nodeCount} nodes indexed)${catalogNote}\n`);
    return 0;
  } finally {
    store.close();
  }
}
