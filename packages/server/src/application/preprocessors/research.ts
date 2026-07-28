import type { Provider } from '@zhixuan92/multi-model-agent-core';
import type { ResearchConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import {
  BraveClient,
  runOrchestrator,
  parseQueryPlan,
  serializeEvidencePack,
  summarizeSourcesUsed,
  resolveEnabledAdapters,
  arxivSearch,
  semanticScholarSearch,
  githubSearch,
  openalexSearch,
  crossrefSearch,
  pubmedSearch,
} from '@zhixuan92/multi-model-agent-core/research';
import type { SourceUsage, BraveSearchOptions } from '@zhixuan92/multi-model-agent-core/research';
import type { Preprocessor } from './types.js';

interface ResearchContext {
  /** Serialized evidence pack to inject into the implementer prompt. */
  evidenceMarkdown: string;
  /** Structured source-usage summary for the response envelope. */
  sourcesUsed: SourceUsage[];
}

const QUERY_PLAN_PROMPT = `You are a research query planner. Given a research question and background, emit ONLY a JSON query plan — no prose, no code fences.

The JSON must conform to this shape:
{
  "braveQueries": [{"q": "<query>", "freshness": "pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD", "endpoint": "web|news", "siteFilter": "site:domain.com"}, ...],
  "arxivQueries":           ["<search query string>", ...],
  "semanticScholarQueries": ["<search query string>", ...],
  "githubQueries":          [{"q": "<search query string>", "kind": "repo|code"}, ...],
  "openalexQueries":        ["<search query string>", ...],
  "crossrefQueries":        ["<search query string>", ...],
  "pubmedQueries":          ["<search query string>", ...]
}

Rules:
- Max 8 entries per array, max 200 chars per query string.
- Phrase queries as topical keywords, NOT full sentences.
- Empty arrays are allowed for sources you do not need.
- braveQueries: freshness, endpoint, siteFilter are all optional. Omit for default web search.
  Use freshness for recent/current data. Use endpoint:"news" for financial/news topics.
  Use siteFilter to restrict to known authoritative domains (e.g., "site:sec.gov").
- openalexQueries: broadest academic coverage (250M+ works, all disciplines).
- crossrefQueries: DOI-registered publications, authoritative metadata.
- pubmedQueries: biomedical/life-sciences focus, use MeSH terms when appropriate.
- Emit ONLY the JSON object.`;

/**
 * Turn 1 + orchestrator: ask the implementer LLM for a QueryPlan, then fan
 * out across real adapters to gather an EvidencePack. Falls back gracefully:
 * - If the LLM output isn't parseable as a QueryPlan, returns null (caller
 *   proceeds with LLM-only research).
 * - If the orchestrator throws, returns null.
 */
async function prepareResearchContext(
  researchQuestion: string,
  background: string,
  implProvider: Provider,
  researchCfg: ResearchConfig,
  taskId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ResearchContext | null> {
  // --- Turn 1: generate a query plan via the implementer LLM ---
  const planSession = implProvider.openSession({
    cwd,
    wallClockDeadline: Date.now() + 60_000,  // 60s budget for plan generation
    abortSignal: signal,
    taskId,
    taskIndex: 0,
  });

  try {
    const planPrompt = [
      QUERY_PLAN_PROMPT,
      '',
      '## Research Question',
      researchQuestion,
      '',
      '## Background',
      background,
    ].join('\n');

    const planTurn = await planSession.send(planPrompt);
    const planOutput = planTurn.output.trim();

    // Extract JSON from the output — the LLM may wrap it in code fences
    let jsonStr = planOutput;
    const fenceMatch = planOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    const queryPlan = parseQueryPlan(jsonStr);

    // --- Orchestrator: fan out queries against real APIs ---
    const enabledAdapters = resolveEnabledAdapters(researchCfg.builtinAdapters, {
      semanticScholarApiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
      githubPat: researchCfg.builtinAdapters.githubPat,
    });

    // Build BraveClient only if API keys are configured
    const hasBraveKeys = researchCfg.brave.apiKeys.length > 0;
    const braveClient = hasBraveKeys ? new BraveClient(researchCfg.brave) : null;

    const pack = await runOrchestrator(queryPlan, {
      enabledAdapters,
      brave: {
        search: async (query: string, options?: BraveSearchOptions) => {
          if (!braveClient) {
            throw new Error('brave_not_configured: no API keys');
          }
          return braveClient.search(query, options);
        },
      },
      adapters: {
        arxiv: (q) => arxivSearch(q),
        semanticScholar: (q) => semanticScholarSearch(q, {
          apiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
        }),
        github: (q, kind) => githubSearch(q, {
          kind,
          pat: researchCfg.builtinAdapters.githubPat,
        }),
        openalex: (q) => openalexSearch(q, {
          contactEmail: researchCfg.builtinAdapters.contactEmail,
        }),
        crossref: (q) => crossrefSearch(q, {
          contactEmail: researchCfg.builtinAdapters.contactEmail,
        }),
        pubmed: (q) => pubmedSearch(q, {
          apiKey: researchCfg.builtinAdapters.pubmedApiKey,
        }),
      },
      perAdapterTimeoutMs: researchCfg.brave.timeoutMs,
      totalDeadlineMs:     30_000,
      concurrencyCap:      4,
    });

    const evidenceMarkdown = serializeEvidencePack(pack);
    const sourcesUsed = summarizeSourcesUsed(pack);

    process.stderr.write(
      `[mma] event=research_evidence_ready ts=${new Date().toISOString()} task=${taskId} sources=${pack.sources.length} failed=${pack.failedAttempts.length}\n`,
    );

    return { evidenceMarkdown, sourcesUsed };
  } catch (err) {
    process.stderr.write(
      `[mma] event=research_preprocess_failed ts=${new Date().toISOString()} task=${taskId} error="${((err instanceof Error ? err.message : String(err))).replace(/"/g, '\\"')}"\n`,
    );
    return null;
  } finally {
    try { await planSession.close(); } catch { /* best-effort */ }
  }
}

/**
 * Research pre-processing: Turn 1 (query plan) + orchestrator. On success the
 * evidence pack rides back as a payload suffix so the implementer synthesizes
 * from actual sources, not training-data recall. On failure (unparseable plan,
 * orchestrator error) the task proceeds with LLM-only research.
 */
export const researchPreprocessor: Preprocessor = async ({ taskId, cwd, payload, config, implementerProvider, signal }) => {
  const researchPayload = payload as { prompt: string };
  const researchCtx = await prepareResearchContext(
    researchPayload.prompt,
    '',
    implementerProvider,
    config.research,
    taskId,
    cwd,
    signal,
  );
  if (!researchCtx) return {};
  return {
    payloadSuffix: [
      '',
      '---',
      '',
      '## Pre-fetched Evidence (from real API queries)',
      '',
      researchCtx.evidenceMarkdown,
    ].join('\n'),
    sourcesUsed: researchCtx.sourcesUsed,
  };
};
