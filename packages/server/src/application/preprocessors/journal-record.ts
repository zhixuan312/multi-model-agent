import * as path from 'node:path';
import {
  JournalIndexStore,
  JournalStore,
  searchCandidatesForRecordBatch,
  parseRecordDecisions,
} from '@zhixuan92/multi-model-agent-core';
import type { Preprocessor } from './types.js';

/**
 * journal_record pre-processing: one label per submitted record so the
 * reviewer can run the same completeness check as execute_plan (every
 * record must appear exactly once across recorded[]/failed[]).
 *
 * Candidate injection: the deterministic engine retrieves supersede/refine/merge
 * candidates per record so the implementer decides against real nodes.
 * `searchCandidatesForRecordBatch` runs health + freshness ONCE for the whole
 * batch (not once per record — nothing in the store changes between records
 * within one request, so per-record health/freshness was pure repeat work)
 * and searches every record SEQUENTIALLY (not Promise.all): the underlying
 * search opens a SQLite transaction (syncIndexIncremental → BEGIN) on the
 * store's single connection, so concurrent searches would throw "cannot
 * start a transaction within a transaction".
 *
 * `JournalIndexStore` (opened below, a derived SQLite index the store owns
 * for search/candidate ranking) and `JournalStore` (opened in
 * `applyDecisions`, the authoritative markdown-file node store) stay on
 * separate handles: `JournalStore` never opens a database connection at all
 * — it reads/writes `.mma/journal/nodes/*.md` directly — so there is no
 * SQLite handle for it to share with `JournalIndexStore`'s. Nor could the two
 * share a lifetime even if `JournalStore` did use SQLite: the index store is
 * opened, used, and closed here (candidate search happens before the
 * implementer runs), while `JournalStore` is opened later, only if/when
 * `applyDecisions` runs against the implementer's output.
 */
export const journalRecordPreprocessor: Preprocessor = async ({ cwd, payload }) => {
  const jrPayload = payload as { records: Array<{ prompt: string; topic?: string }> };
  const dispatchedTasks = jrPayload.records.map((record, index) => {
    const label = record.topic ? `${record.topic} :: ${record.prompt}` : record.prompt;
    return `[record ${index + 1}] ${label}`.slice(0, 200);
  });

  const indexStore = await JournalIndexStore.open({ journalRoot: path.join(cwd, '.mma', 'journal') });
  try {
    const candidatesByRecord = await searchCandidatesForRecordBatch(indexStore, jrPayload.records);
    (payload as Record<string, unknown>).candidatesByRecord = candidatesByRecord;
  } finally {
    // Close the WAL connection so no lock leaks per request.
    indexStore.close();
  }

  // Deterministic apply hook (recall writes nothing). Parses the implementer's
  // decision array and applies it atomically to the corpus. A parse/apply throw
  // does NOT crash the task: it degrades to the documented per-record
  // recorded[]/failed[] shape with every submitted record in failed[] (reason =
  // the parse/apply error) and invariantsPassed=false, so the reviewer still
  // runs and the pipeline produces the contract shape (mma-journal-record
  // SKILL.md:56).
  const applyDecisions = async (implementerOutput: string) => {
    try {
      const store = await JournalStore.open({ journalRoot: path.join(cwd, '.mma', 'journal') });
      return await store.applyRecordBatch(parseRecordDecisions(implementerOutput));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const submitted = jrPayload.records ?? [];
      return {
        recorded: [],
        failed: submitted.map((record) => ({ learning: record.prompt, reason })),
        invariantsPassed: false,
      };
    }
  };

  return {
    dispatchedTasks,
    totalTasks: jrPayload.records.length,
    applyDecisions,
  };
};
