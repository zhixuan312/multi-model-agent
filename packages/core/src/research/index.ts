// research/index.ts — barrel for the research pipeline. Exposes the
// orchestrator, query-plan parser, evidence-pack types/serializer, Brave
// client, and adapter helpers so the server handler can wire them together.

export { runOrchestrator } from './orchestrator.js';
export type { OrchestratorDeps } from './orchestrator.js';
export { parseQueryPlan, QueryPlanSchema } from './query-plan.js';
export type { QueryPlan } from './query-plan.js';
export {
  applyBudget,
  serializeEvidencePack,
  summarizeSourcesUsed,
} from './evidence-pack.js';
export type {
  EvidencePack,
  EvidenceSource,
  FailedAttempt,
  SourceUsage,
} from './evidence-pack.js';
export { BraveClient } from './web-search.js';
export type { BraveSearchOptions, BraveSearchResult, BraveSearchResponse } from './web-search.js';
export {
  resolveEnabledAdapters,
  arxivSearch,
  semanticScholarSearch,
  githubSearch,
  openalexSearch,
  crossrefSearch,
  pubmedSearch,
} from './adapters/index.js';
export type { AdapterCredentials } from './adapters/index.js';
export type { AdapterId, AdapterResult } from './adapters/types.js';
