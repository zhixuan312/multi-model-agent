import type { MultiModelConfig } from '../types.js';
import type { ContextBlockStore } from '../context/context-block-store.js';
import type {
  DraftTask,
  IntakeResult,
  IntakeProgress,
  ReadyDraft,
  ClarificationEntry,
  HardError,
} from './types.js';
import { inferMissingFields } from './infer.js';
import { classifyDraft } from './classify.js';
import { resolveDraft } from './resolve.js';

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

function orderByRisk(questions: string[]): string[] {
  const riskWords = /security|permission|delete|remove|deploy|credential|secret/i;
  const scopeWords = /scope|file|target|which/i;
  return [...questions].sort((a, b) => {
    const aRisk = riskWords.test(a) ? 0 : scopeWords.test(a) ? 1 : 2;
    const bRisk = riskWords.test(b) ? 0 : scopeWords.test(b) ? 1 : 2;
    return aRisk - bRisk;
  });
}

const SENSITIVE_PATTERNS = /\b(provider|sandbox|auth\s*state|testCommand|credential|api[_-]?key)\b/i;
function sanitizeAssumption(assumption: string): string {
  if (SENSITIVE_PATTERNS.test(assumption)) {
    return assumption.replace(SENSITIVE_PATTERNS, '[redacted]');
  }
  return assumption;
}

export function runIntakePipeline(
  drafts: DraftTask[],
  config: MultiModelConfig,
  contextBlockStore?: ContextBlockStore,
): IntakeResult {
  const ready: ReadyDraft[] = [];
  const clarifications: ClarificationEntry[] = [];
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

    if (classified.classification === 'ready') {
      const task = resolveDraft(inferred, config);
      ready.push({ task, draftId: inferred.draftId, taskIndex: i });
    } else {
      const rawQuestions = inferred.questions ?? classified.reasons.map(r =>
        `I'm not confident about this interpretation — ${r}. Is my proposed draft correct?`
      );
      const orderedQuestions = orderByRisk(rawQuestions).slice(0, 5);

      const sanitizedAssumptions = (inferred.assumptions ?? []).map(sanitizeAssumption);

      clarifications.push({
        draftId: inferred.draftId,
        taskIndex: i,
        proposedDraft: {
          prompt: inferred.prompt,
          filePaths: inferred.filePaths,
          done: inferred.done,
        },
        assumptions: sanitizedAssumptions,
        questions: orderedQuestions,
        reason: classified.reasons.join('; ') || 'MCP cannot form one unambiguous execution plan',
      });
    }
  }

  const intakeProgress: IntakeProgress = {
    totalDrafts: drafts.length,
    readyDrafts: ready.length,
    clarificationDrafts: clarifications.length,
    hardErrorDrafts: hardErrors.length,
    executedDrafts: 0,
  };

  return { ready, clarifications, hardErrors, intakeProgress };
}