// packages/core/src/research/research-pre-loop.ts
//
// Called from perform-implementation BEFORE runReadRouteImplementer when
// the route is /research. Runs turn-1 plan + Step-2 orchestrator, then
// produces a cachedPrefix that embeds the EvidencePack so the N-criterion
// loop synthesises against shared evidence.
//
// Keeps read-route-implementer pure (route-agnostic).

import type { Session } from '../types/run-result.js';
import type { ResearchConfig } from '../config/schema.js';
import { runTwoTurnDriver } from '../tools/research/two-turn-driver.js';
import { runOrchestrator } from './orchestrator.js';
import {
  resolveEnabledAdapters,
  arxivSearch, semanticScholarSearch, githubSearch,
} from './adapters/index.js';
import { BraveClient } from './web-search.js';
import { compileResearchImplementerPrefix } from '../tools/research/brief-slot.js';
import { summarizeSourcesUsed, type EvidencePack, type SourceUsage } from './evidence-pack.js';

export interface ResearchPreLoopInput {
  session:               Pick<Session, 'send'>;
  researchQuestion:      string;
  background?:           string;
  resolvedContextBlocks: Array<{ id: string; content: string }>;
  cfg:                   ResearchConfig;
}

export interface ResearchPreLoopResult {
  cachedPrefix: string;
  pack:         EvidencePack;
  /** Deterministic `## Sources used` table, derived from the pack rather than
   *  parsed from worker markdown (which the per-criterion loop never emits). */
  sourcesUsed:  SourceUsage[];
}

export async function runResearchPreLoop(
  inp: ResearchPreLoopInput,
): Promise<ResearchPreLoopResult> {
  const brave = new BraveClient(inp.cfg.brave);
  const enabled = resolveEnabledAdapters(inp.cfg.builtinAdapters, {
    semanticScholarApiKey: inp.cfg.builtinAdapters.semanticScholarApiKey,
    githubPat:             inp.cfg.builtinAdapters.githubPat,
  });
  const driverResult = await runTwoTurnDriver({
    session: inp.session,
    runOrchestrator: (plan) => runOrchestrator(plan, {
      enabledAdapters: enabled,
      brave:    { search: (q) => brave.search(q) },
      adapters: {
        arxiv:           (q) => arxivSearch(q, { maxResults: 5 }),
        semanticScholar: (q) => semanticScholarSearch(q, { maxResults: 5, apiKey: inp.cfg.builtinAdapters.semanticScholarApiKey }),
        github:          (q, kind) => githubSearch(q, { kind, maxResults: 5, pat: inp.cfg.builtinAdapters.githubPat }),
      },
      perAdapterTimeoutMs: 8000,
      totalDeadlineMs:     20000,
      concurrencyCap:      8,
    }),
    researchQuestion: inp.researchQuestion,
    background:       inp.background,
  });
  const cachedPrefix = compileResearchImplementerPrefix({
    researchQuestion: inp.researchQuestion,
    background:       inp.background,
    pack:             driverResult.pack,
    contextBlocks:    inp.resolvedContextBlocks,
  });
  return {
    cachedPrefix,
    pack:        driverResult.pack,
    sourcesUsed: summarizeSourcesUsed(driverResult.pack),
  };
}
