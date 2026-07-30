import * as path from 'node:path';
import { JournalIndexStore, searchCandidatesForRecall } from '@zhixuan92/multi-model-agent-core';
import type { Preprocessor } from './types.js';

/**
 * journal_recall pre-processing: inject engine-retrieved candidates so the
 * implementer judges/synthesizes from real nodes instead of scanning the corpus.
 */
export const journalRecallPreprocessor: Preprocessor = async ({ cwd, payload }) => {
  const jrPayload = payload as { prompt: string; topic?: string; includeHistory?: boolean };
  const includeHistory = jrPayload.includeHistory ?? false;
  const indexStore = await JournalIndexStore.open({ journalRoot: path.join(cwd, '.mma', 'journal') });
  try {
    await indexStore.ensureHealthy();
    (payload as Record<string, unknown>).candidates = await searchCandidatesForRecall(indexStore, {
      prompt: jrPayload.prompt, topic: jrPayload.topic, includeHistory,
    });
    (payload as Record<string, unknown>).includeHistory = includeHistory;
  } finally {
    // Close the WAL connection so no lock leaks per request.
    indexStore.close();
  }
  return {};
};
