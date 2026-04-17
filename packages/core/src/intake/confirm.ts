import type {
  ConfirmationEntry,
  ConfirmDraftError,
  ConfirmResult,
  DraftTask,
} from './types.js';
import type { ClarificationStore } from './clarification-store.js';
import { validateSource } from './source-schema.js';

const DEFAULT_MAX_ROUNDS = 3;

function checkScopeCompatibility(source: DraftTask['source'], entry: ConfirmationEntry): string | null {
  const noFiles = !entry.filePaths || entry.filePaths.length === 0;

  if (source.route === 'verify_work') {
    const checklist = (source as { checklist: string[] }).checklist;
    if (noFiles && checklist.length > 0) {
      return `Scope edit removes all files but checklist has ${checklist.length} items.`;
    }
  }

  if (source.route === 'audit_document') {
    const hasInlineDoc = 'document' in source.originalInput && source.originalInput.document;
    if (noFiles && !hasInlineDoc) {
      return `Scope edit removes all files and no inline document exists — audit has no target.`;
    }
  }

  if (source.route === 'review_code') {
    const hasInlineCode = (source as { inlineContent?: string }).inlineContent;
    if (noFiles && !hasInlineCode) {
      return `Scope edit removes all files and no inline code exists — review has no scope.`;
    }
  }

  return null;
}

export interface ConfirmOptions {
  maxRounds?: number;
}

export function processConfirmations(
  store: ClarificationStore,
  clarificationId: string,
  confirmations: Map<string, ConfirmationEntry>,
  options?: ConfirmOptions,
): ConfirmResult {
  const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const confirmedDrafts: DraftTask[] = [];
  const errors: ConfirmDraftError[] = [];
  const executedResultRefs: string[] = [];

  const set = store.get(clarificationId);
  if (!set) {
    errors.push({
      draftId: '',
      errorCode: 'clarification_not_found',
      message: `Clarification set '${clarificationId}' not found or expired. Re-dispatch from scratch.`,
    });
    return { confirmedDrafts, errors, executedResultRefs };
  }

  for (const [draftId, entry] of confirmations) {
    if (set.executedDraftIds.has(draftId)) {
      errors.push({
        draftId,
        errorCode: 'draft_already_executed',
        message: `Draft '${draftId}' was already confirmed and executed.`,
      });
      executedResultRefs.push(draftId);
      continue;
    }

    const stored = set.drafts.get(draftId);
    if (!stored) {
      errors.push({
        draftId,
        errorCode: 'draft_not_found',
        message: `Draft '${draftId}' not found in clarification set.`,
      });
      continue;
    }

    if (stored.roundCount >= maxRounds) {
      errors.push({
        draftId,
        errorCode: 'draft_refused',
        message: `Draft '${draftId}' exceeded maximum ${maxRounds} clarification rounds.`,
      });
      continue;
    }

    if (!entry.prompt?.trim()) {
      errors.push({
        draftId,
        errorCode: 'invalid_confirmation',
        message: `Confirmation for '${draftId}' requires a non-empty prompt.`,
      });
      continue;
    }

    try {
      validateSource(stored.draft.source);
    } catch {
      errors.push({
        draftId,
        errorCode: 'source_validation_failed',
        message: `Source validation failed for '${draftId}'. Schema may have changed since clarification was created.`,
      });
      store.incrementRound(clarificationId, draftId);
      continue;
    }

    const scopeIncompat = checkScopeCompatibility(stored.draft.source, entry);
    if (scopeIncompat) {
      errors.push({
        draftId,
        errorCode: 'source_validation_failed',
        message: scopeIncompat,
      });
      store.incrementRound(clarificationId, draftId);
      continue;
    }

    const confirmedDraft: DraftTask = {
      ...stored.draft,
      prompt: entry.prompt,
      filePaths: entry.filePaths,
      done: entry.done,
      confirmed: true,
      questions: undefined,
      assumptions: undefined,
    };

    confirmedDrafts.push(confirmedDraft);
  }

  return { confirmedDrafts, errors, executedResultRefs };
}