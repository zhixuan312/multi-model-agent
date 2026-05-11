import type { MultiModelConfig } from '../types.js';
import type { ContextBlockStore } from '../stores/context-block-tool.js';
import type {
  DraftTask,
  IntakeResult,
  IntakeProgress,
  ReadyDraft,
  HardError,
} from './types.js';
import * as fs from 'node:fs';
import { inferMissingFields } from './field-inferer.js';
import { classifyDraft } from './classify.js';
import { resolveDraft } from './resolve.js';
import { estimateContextSize, checkOverflow } from './context-overflow-estimator.js';

function expandDraftContextBlocks(
  draft: DraftTask,
  store?: ContextBlockStore,
): DraftTask | HardError {
  if (!draft.contextBlockIds?.length || !store) return draft;

  const contents: string[] = [];
  for (const id of draft.contextBlockIds) {
    const content = store.get(id);
    if (content === undefined) {
      return {
        draftId: draft.draftId,
        taskIndex: 0,
        error: `Context block '${id}' not found or expired`,
        errorCode: 'context_block_not_found',
      };
    }
    contents.push(content);
  }

  const separator = '\n\n---\n\n';
  return {
    ...draft,
    prompt: contents.join(separator) + separator + draft.prompt,
    contextBlockIds: undefined,
  };
}

function isHardError(result: DraftTask | HardError): result is HardError {
  return 'errorCode' in result;
}

export function runIntakePipeline(
  drafts: DraftTask[],
  config: MultiModelConfig,
  contextBlockStore?: ContextBlockStore,
  _batchId?: string,
): IntakeResult {
  const ready: ReadyDraft[] = [];
  const hardErrors: HardError[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];

    const expanded = expandDraftContextBlocks(draft, contextBlockStore);
    if (isHardError(expanded)) {
      hardErrors.push({ ...expanded, taskIndex: i });
      continue;
    }

    const inferred = inferMissingFields(expanded);

    const classified = classifyDraft(inferred);

    if (classified.classification === 'unrecoverable') {
      hardErrors.push({
        draftId: inferred.draftId,
        taskIndex: i,
        error: classified.reasons.join('; '),
        errorCode: 'unrecoverable_ambiguity',
      });
      continue;
    }

    // needs_confirmation drafts are treated as ready — the classification
    // is advisory only; there is no longer a clarification gate.
    const task = resolveDraft(inferred, config);

    const tier = task.agentType ?? 'standard';
    const agentCfg = config.agents[tier];
    const modelId = agentCfg?.model ?? 'unknown';
    const modelCap = agentCfg?.inputTokenSoftLimit ?? 200_000;
    const fileContributors = (draft.filePaths ?? []).map(p => {
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch { /* missing file: contributes 0 */ }
      return { kind: 'filePath' as const, path: p, estimatedTokens: Math.ceil(bytes / 3.5) };
    });
    const blockContributors: Array<{ kind: 'contextBlock'; id: string; estimatedTokens: number }> = [];
    const blockLengths: number[] = [];
    for (const blockId of (draft.contextBlockIds ?? [])) {
      const content = contextBlockStore?.get(blockId);
      if (content) {
        blockLengths.push(content.length);
        blockContributors.push({ kind: 'contextBlock', id: blockId, estimatedTokens: Math.ceil(content.length / 3.5) });
      }
    }
    const estimated = estimateContextSize({
      filePaths: draft.filePaths ?? [],
      contextBlockLengthsChars: blockLengths,
      baseInstructionsTokens: 4000,
      reservedCompletionTokens: 64000,
    });
    const overflow = checkOverflow({
      estimatedTokens: estimated,
      modelCap,
      tier,
      model: modelId,
      contributors: [...fileContributors, ...blockContributors],
    });
    if (overflow) {
      hardErrors.push({
        draftId: inferred.draftId,
        taskIndex: i,
        error: overflow.message,
        errorCode: overflow.error,
        details: overflow.details as unknown as Record<string, unknown>,
      });
      continue;
    }

    ready.push({ task, draftId: inferred.draftId, taskIndex: i });
  }

  const intakeProgress: IntakeProgress = {
    totalDrafts: drafts.length,
    readyDrafts: ready.length,
    hardErrorDrafts: hardErrors.length,
    executedDrafts: 0,
  };

  return { ready, hardErrors, intakeProgress };
}