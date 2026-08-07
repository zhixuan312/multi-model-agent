import type { PreprocessorMap } from './types.js';
import { executePlanPreprocessor } from './execute-plan.js';
import { journalRecordPreprocessor } from './journal-record.js';
import { journalRecallPreprocessor } from './journal-recall.js';
import { specPreprocessor, planPreprocessor } from './spec-plan.js';
import { researchPreprocessor } from './research.js';
import { investigatePreprocessor } from './investigate.js';

export { PreprocessFailure } from './types.js';
export type { Preprocessor, PreprocessorArgs, PreprocessResult } from './types.js';

/**
 * Per-type pre-pipeline processing, keyed off TaskType. Types absent from this
 * map dispatch straight to the pipeline. Each preprocessor runs BEFORE any
 * provider session opens (research being the deliberate exception: its
 * query-plan turn IS a provider call) and may terminate the task by throwing
 * PreprocessFailure.
 */
export const PREPROCESSORS: PreprocessorMap = {
  execute_plan: executePlanPreprocessor,
  journal_record: journalRecordPreprocessor,
  journal_recall: journalRecallPreprocessor,
  spec: specPreprocessor,
  plan: planPreprocessor,
  research: researchPreprocessor,
  investigate: investigatePreprocessor,
};
