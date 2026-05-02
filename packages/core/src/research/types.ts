// Re-exports for the research subsystem. Concrete config type comes from config/schema.ts.
export type { AdapterId, AdapterResult, AdapterCallContext } from './adapters/types.js';

/**
 * Tool definition shape that runner adapters consume. The explore executor
 * builds an array of these for the external worker (taskIndex=1) and sets
 * them on `TaskSpec.customToolset`. Runner adapters merge with the standard
 * surface when present.
 */
export interface ResearchToolDefinition {
  name: 'web_search' | 'web_fetch' | 'arxiv' | 'semantic_scholar' | 'github_search' | 'rss';
  description: string;
  inputSchema: unknown;                                  // Zod or JSON-Schema; runner adapter normalizes
  invoke(input: unknown): Promise<unknown>;
}
