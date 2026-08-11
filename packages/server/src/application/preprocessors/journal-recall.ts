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
    const result = await searchCandidatesForRecall(indexStore, {
      prompt: jrPayload.prompt, topic: jrPayload.topic, includeHistory,
    });
    (payload as Record<string, unknown>).candidates = result.candidates;
    // Coverage travels with the payload: the worker states what it could not
    // see rather than presenting a budget-trimmed set as the whole match.
    (payload as Record<string, unknown>).candidatesWithheld = result.withheld;
    (payload as Record<string, unknown>).candidatesTotalRanked = result.totalRanked;
    (payload as Record<string, unknown>).includeHistory = includeHistory;
  } finally {
    // Close the WAL connection so no lock leaks per request.
    indexStore.close();
  }
  return {};
};
