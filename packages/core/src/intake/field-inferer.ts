import type { AgentType } from '../types.js';
import type { DraftTask, SourceRoute } from './types.js';

export interface BriefDefaults {
  agentType?: AgentType;
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
}

export const ROUTE_DEFAULTS: Record<SourceRoute, BriefDefaults> = {
  delegate_tasks:       { agentType: 'standard', reviewPolicy: 'full' },
  execute_plan:         { agentType: 'standard', reviewPolicy: 'full' },
  audit_document:       { agentType: 'complex',  reviewPolicy: 'none' },
  review_code:          { agentType: 'complex',  reviewPolicy: 'none' },
  verify_work:          { agentType: 'complex',  reviewPolicy: 'none' },
  debug_task:           { agentType: 'complex',  reviewPolicy: 'none' },
  investigate_codebase: { agentType: 'complex',  reviewPolicy: 'none' },
};

export function inferDefaults(route: SourceRoute): BriefDefaults {
  const defaults = ROUTE_DEFAULTS[route];
  if (!defaults) throw new Error(`no defaults table entry for route '${route}'`);
  return defaults;
}

const FILE_PATH_PATTERN = /\b([\w./\\-]+\.\w{1,5})\b/g;
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'yaml', 'yml',
  'toml', 'py', 'rs', 'go', 'java', 'css', 'html', 'sql',
]);

const ANALYSIS_VERBS = /\b(summarize|describe|explain|list|count|read|review|analyze|check|inspect)\b/i;
const WRITE_VERBS = /\b(fix|change|update|refactor|delete|migrate|implement|add|create|modify)\b/i;

export function inferMissingFields(draft: DraftTask): DraftTask {
  const assumptions: string[] = [...(draft.assumptions ?? [])];
  let done = draft.done;
  let filePaths = draft.filePaths;

  const promptWords = draft.prompt.trim().split(/\s+/);
  const fileRefs = [...draft.prompt.matchAll(FILE_PATH_PATTERN)]
    .filter(m => { const ext = m[1].split('.').pop()?.toLowerCase(); return ext && KNOWN_EXTENSIONS.has(ext); });
  const hasSingleScope = (draft.filePaths?.length === 1) || (fileRefs.length <= 1);
  const isTrivial =
    ANALYSIS_VERBS.test(draft.prompt) &&
    !WRITE_VERBS.test(draft.prompt) &&
    promptWords.length < 100 &&
    hasSingleScope;

  if (!done && isTrivial) {
    done = 'Provide a clear, complete response addressing the request.';
    assumptions.push('inferred done condition for analysis-only task');
  }

  if (!filePaths?.length) {
    const matches = [...draft.prompt.matchAll(FILE_PATH_PATTERN)];
    const candidates = matches
      .map(m => m[1])
      .filter(p => {
        const ext = p.split('.').pop()?.toLowerCase();
        return ext && KNOWN_EXTENSIONS.has(ext);
      });

    if (candidates.length > 0 && candidates.length <= 3) {
      filePaths = [...new Set(candidates)];
      assumptions.push('inferred file scope from prompt');
    }
  }

  if (assumptions.length === (draft.assumptions?.length ?? 0)) {
    return draft;
  }

  return { ...draft, done, filePaths, assumptions };
}
