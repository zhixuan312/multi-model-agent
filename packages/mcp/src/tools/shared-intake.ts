import type { DraftTask } from '@zhixuan92/multi-model-agent-core/intake/types';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { runIntakePipeline } from '@zhixuan92/multi-model-agent-core/intake/pipeline';
import { ClarificationStore } from '@zhixuan92/multi-model-agent-core/intake/clarification-store';
import { buildClarificationAwareResponse } from '../clarification-response.js';

export async function runPresetIntake(
  drafts: DraftTask[],
  config: MultiModelConfig,
  clarificationStore: ClarificationStore,
  runTasks: (tasks: unknown[], config: MultiModelConfig) => Promise<RunResult[]>,
) {
  const intakeResult = runIntakePipeline(drafts, config);

  let results: RunResult[] = [];

  if (intakeResult.ready.length > 0) {
    results = await runTasks(intakeResult.ready.map(r => r.task), config);
    intakeResult.intakeProgress.executedDrafts = results.length;
  }

  let clarificationId: string | undefined;
  if (intakeResult.clarifications.length > 0) {
    const storedDrafts = intakeResult.clarifications.map(c => {
      const draft = drafts.find(d => d.draftId === c.draftId)!;
      return { draft, taskIndex: c.taskIndex, roundCount: 0 };
    });
    clarificationId = clarificationStore.create(storedDrafts, '');
  }

  return { results, intakeResult, clarificationId };
}