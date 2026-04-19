import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, RunResult } from '@zhixuan92/multi-model-agent-core';
import type { RunTasksOptions } from '@zhixuan92/multi-model-agent-core/run-tasks';
import type { ClarificationStore } from '@zhixuan92/multi-model-agent-core/intake/clarification-store';
import type { ConfirmationEntry } from '@zhixuan92/multi-model-agent-core/intake/types';
import { processConfirmations } from '@zhixuan92/multi-model-agent-core/intake/confirm';
import { runIntakePipeline } from '@zhixuan92/multi-model-agent-core/intake/pipeline';
import { getMaxRoundsPerDraft } from '@zhixuan92/multi-model-agent-core/intake/feature-flag';
import { buildUnifiedResponse } from './shared.js';
import { truncateResults } from './truncation.js';

export const confirmClarificationsSchema = z.object({
  clarificationId: z.string().describe('ID of the clarification set to resume'),
  confirmations: z.record(
    z.string(),
    z.object({
      prompt: z.string().describe('Confirmed prompt (required)'),
      filePaths: z.array(z.string()).optional().describe('Confirmed file scope'),
      done: z.string().optional().describe('Confirmed done condition'),
    }),
  ).describe('Confirmation entries keyed by draftId'),
});

export function registerConfirmClarifications(
  server: McpServer,
  config: MultiModelConfig,
  clarificationStore: ClarificationStore,
  runTasksImpl: (tasks: TaskSpec[], config: MultiModelConfig, options?: RunTasksOptions) => Promise<RunResult[]>,
  rememberBatch: (tasks: TaskSpec[]) => string,
): void {
  server.tool(
    'confirm_clarifications',
    'Resume a clarification set by confirming or editing drafted tasks',
    confirmClarificationsSchema.shape,
    async (params: z.infer<typeof confirmClarificationsSchema>) => {
      const confirmations = new Map<string, ConfirmationEntry>(
        Object.entries(params.confirmations),
      );

      const maxRounds = getMaxRoundsPerDraft(config);

      const confirmResult = processConfirmations(
        clarificationStore,
        params.clarificationId,
        confirmations,
        { maxRounds },
      );

      if (confirmResult.errors.some(e => e.errorCode === 'clarification_not_found')) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: confirmResult.errors[0].message,
              errorCode: 'clarification_not_found',
            }),
          }],
          isError: true,
        };
      }

      const set = clarificationStore.get(params.clarificationId);
      const originalBatchId = set?.originalBatchId ?? '';

      const intakeResult = runIntakePipeline(confirmResult.confirmedDrafts, config);

      const newBatchId = rememberBatch(
        intakeResult.ready.length > 0
          ? intakeResult.ready.map(r => r.task)
          : [],
      );

      let results: RunResult[] = [];
      if (intakeResult.ready.length > 0) {
        results = await runTasksImpl(
          intakeResult.ready.map(r => r.task),
          config,
          {},
        );
        for (const r of intakeResult.ready) {
          clarificationStore.markExecuted(params.clarificationId, r.draftId);
        }
      }

      for (const c of intakeResult.clarifications) {
        const storedSet = clarificationStore.get(params.clarificationId);
        const stored = storedSet?.drafts.get(c.draftId);
        if (stored?.previousReasons) {
          const prevSorted = [...stored.previousReasons].sort().join('|');
          const newSorted = [...(c.questions || [])].sort().join('|');
          if (prevSorted === newSorted) {
            confirmResult.errors.push({
              draftId: c.draftId,
              errorCode: 'draft_refused',
              message: `Draft '${c.draftId}' bounced with identical reasons across rounds — unresolvable.`,
            });
            clarificationStore.removeDraft(params.clarificationId, c.draftId);
            intakeResult.clarifications = intakeResult.clarifications.filter(x => x.draftId !== c.draftId);
            continue;
          }
        }
        if (stored) {
          stored.previousReasons = c.questions || [];
        }
        clarificationStore.incrementRound(params.clarificationId, c.draftId);
      }

      clarificationStore.touchForConfirm(params.clarificationId);

      intakeResult.intakeProgress.executedDrafts = intakeResult.ready.length;

      // Track start time for wall clock measurement
      const startMs = Date.now();

      clarificationStore.cleanupIfResolved(params.clarificationId);

      // Apply same auto-escape truncation as delegate_tasks
      const threshold = config.defaults.largeResponseThresholdChars ?? 65_000;
      const truncatedResults = truncateResults(
        results.map(r => ({ status: r.status, output: r.output, filesWritten: r.filesWritten, error: r.error })),
        newBatchId,
        threshold,
      );

      // Build unified response — only includes remaining clarifications if any
      const remainingClarifications = intakeResult.clarifications.length > 0 ? intakeResult.clarifications : undefined;
      const remainingClarificationId = intakeResult.clarifications.length > 0 ? params.clarificationId : undefined;

      const response = buildUnifiedResponse({
        batchId: newBatchId,
        results: results.map((r, i) => ({ ...r, output: truncatedResults[i].output })),
        tasks: intakeResult.ready.map(r => r.task),
        wallClockMs: Date.now() - startMs,
        clarificationId: remainingClarificationId,
        clarifications: remainingClarifications,
      });

      const responseObj = {
        ...response,
        ...(confirmResult.errors.length > 0 ? { confirmationErrors: confirmResult.errors } : {}),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(responseObj, null, 2) }],
      };
    },
  );
}