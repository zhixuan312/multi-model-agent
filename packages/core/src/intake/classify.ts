import type { DraftTask, ClassificationResult } from './types.js';

const PRESET_ROUTES = new Set(['review_code', 'debug_task', 'verify_work', 'audit_document']);
const MIN_PROMPT_WORDS = 4;
const VAGUE_PATTERNS = [
  /^please$/i,
  /^help$/i,
  /^fix it$/i,
  /^do it$/i,
  /^handle this$/i,
  /^(can|could) you/i,
  /^(can|could) I/i,
];

function getUserContentForRoute(draft: DraftTask): string | undefined {
  switch (draft.source.route) {
    case 'review_code':
      return (draft.source as { code?: string }).code || (draft.source as { inlineContent?: string }).inlineContent;
    case 'audit_document':
      return (draft.source as { document?: string }).document;
    case 'verify_work':
      return (draft.source as { work?: string }).work;
    default:
      return draft.prompt;
  }
}

export function classifyDraft(draft: DraftTask): ClassificationResult {
  const reasons: string[] = [];
  const promptWords = draft.prompt.trim().split(/\s+/).length;

  if (!draft.prompt.trim()) {
    if (draft.source.route === 'delegate_tasks') {
      return {
        draft,
        classification: 'unrecoverable',
        reasons: ['prompt too vague to form any interpretation — requires a fresh request'],
      };
    }
  }

  if (promptWords < 2) {
    return {
      draft,
      classification: 'unrecoverable',
      reasons: ['prompt too vague to form any interpretation — requires a fresh request'],
    };
  }

  if (draft.questions?.length) {
    reasons.push('draft has open questions from compilation');
    return { draft, classification: 'needs_confirmation', reasons };
  }

  const isConfirmed = draft.confirmed === true;

  if (PRESET_ROUTES.has(draft.source.route)) {
    const presetReasons: string[] = [];

    const userContent = getUserContentForRoute(draft);
    if (userContent && userContent.trim().split(/\s+/).length < 2) {
      presetReasons.push('user-provided content is too vague to act on');
    }

    if (draft.filePaths?.some(p => p === '/' || p === '.' || p === '*')) {
      presetReasons.push('file scope is too broad to be actionable');
    }

    if (draft.source.route === 'audit_document' && !draft.filePaths?.length) {
      if (!('document' in draft.source.originalInput)) {
        presetReasons.push('audit has no target — provide filePaths or inline document');
      }
    }

    if (draft.source.route === 'verify_work') {
      const checklist = (draft.source as { checklist?: string[] }).checklist ?? [];
      const VAGUE_CHECKLIST = /^(check|verify|test|ensure)\s+(everything|all|it|this|that)$/i;
      if (checklist.some(item => VAGUE_CHECKLIST.test(item.trim()))) {
        presetReasons.push('checklist contains overly generic items that are not actionable');
      }
    }

    if (presetReasons.length > 0) {
      return { draft, classification: 'needs_confirmation', reasons: presetReasons };
    }
    return { draft, classification: 'ready', reasons: [] };
  }

  if (!isConfirmed) {
    for (const pattern of VAGUE_PATTERNS) {
      if (pattern.test(draft.prompt.trim())) {
        reasons.push('prompt is too vague to form one concrete instruction');
        break;
      }
    }

    if (!draft.filePaths?.length) {
      const multiScopeSignals = [
        /\band\b.*\b(module|service|component|system|layer)/i,
        /\b(modules|services|components|systems|layers)\b/i,
      ];
      for (const pattern of multiScopeSignals) {
        if (pattern.test(draft.prompt)) {
          reasons.push('multiple plausible scopes detected');
          break;
        }
      }
    }

    const behaviorChange = /\b(delete|remove|drop|migrate|deploy|push|publish|send)\b/i;
    const securitySensitive = /\b(auth|credential|secret|token|permission|password|key)\b/i;
    if (behaviorChange.test(draft.prompt) && !draft.filePaths?.length) {
      reasons.push('behavior-changing task without explicit scope');
    }
    if (securitySensitive.test(draft.prompt) && !draft.done) {
      reasons.push('security-sensitive task without explicit done condition');
    }
  }

  const uniqueReasons = [...new Set(reasons)];

  if (uniqueReasons.length > 0) {
    return { draft, classification: 'needs_confirmation', reasons: uniqueReasons };
  }

  return { draft, classification: 'ready', reasons: [] };
}