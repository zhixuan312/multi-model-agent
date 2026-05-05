import { z } from 'zod';
import type { ResearchConfig } from '../../config/schema.js';
import { arxivSearch, semanticScholarSearch, githubSearch, rssAdapter } from '../../research/adapters/index.js';
import { BraveClient } from '../../research/web-search.js';
import { webFetch } from '../../research/web-fetch.js';
import { wrapSearchResults } from '../../research/untrusted-content.js';

export interface ToolDef<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: unknown) => Promise<{ ok: true; result: O } | { ok: false; code: string; message: string }>;
}

export interface BuildToolsInput {
  cfg: ResearchConfig;
  hostAllowlist: ReadonlySet<string>;
  privateNetworkHosts: ReadonlySet<string>;
}

export interface ResearchTools {
  arxiv?: ToolDef<{ query: string; maxResults?: number }, unknown>;
  semantic_scholar?: ToolDef<{ query: string; maxResults?: number }, unknown>;
  github_search?: ToolDef<{ query: string; kind: 'repo' | 'code'; maxResults?: number }, unknown>;
  rss?: ToolDef<{ url: string }, unknown>;
  web_search?: ToolDef<{ query: string; siteFilter?: string }, string>;
  web_fetch: ToolDef<{ url: string }, string>;
}

const wrap = <I, O>(
  name: string,
  schema: z.ZodType<I>,
  exec: (input: I) => Promise<O>,
  description: string,
): ToolDef<I, O> => ({
  name,
  description,
  inputSchema: schema,
  handler: async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'tool_input_invalid', message: parsed.error.message };
    try {
      return { ok: true, result: await exec(parsed.data) };
    } catch (e) {
      return { ok: false, code: 'tool_call_failed', message: e instanceof Error ? e.message : String(e) };
    }
  },
});

export function buildResearchTools(opts: BuildToolsInput): ResearchTools {
  const { cfg, hostAllowlist, privateNetworkHosts } = opts;
  const tools: ResearchTools = {
    web_fetch: wrap(
      'web_fetch',
      z.object({ url: z.string().min(1).max(2048) }),
      async ({ url }) => {
        const r = await webFetch({ url, cfg: cfg.fetch, hostAllowlist, privateNetworkHosts });
        if (r.status === 'error') throw new Error(r.reasonCode);
        return r.body;
      },
      'Fetch a URL whose host is in the per-task allowlist; returns extracted text wrapped in <external-content>.',
    ),
  };

  const trimmedQuery = z.string().trim().min(1).max(256);
  const trimmedURL = z.string().trim().min(1).max(2048);

  if (cfg.builtinAdapters.arxiv) {
    tools.arxiv = wrap(
      'arxiv',
      z.object({ query: trimmedQuery, maxResults: z.number().int().min(1).max(25).optional() }),
      async ({ query, maxResults }) => arxivSearch(query, { maxResults }),
      'Search arxiv.org for academic papers.',
    );
  }
  if (cfg.builtinAdapters.semanticScholar) {
    tools.semantic_scholar = wrap(
      'semantic_scholar',
      z.object({ query: trimmedQuery, maxResults: z.number().int().min(1).max(25).optional() }),
      async ({ query, maxResults }) => semanticScholarSearch(query, { maxResults }),
      'Search Semantic Scholar for academic papers (citation-graph aware).',
    );
  }
  if (cfg.builtinAdapters.githubSearch) {
    tools.github_search = wrap(
      'github_search',
      z.object({
        query: trimmedQuery,
        kind: z.enum(['repo', 'code']),
        maxResults: z.number().int().min(1).max(25).optional(),
      }),
      async ({ query, kind, maxResults }) => githubSearch(query, { kind, maxResults }),
      'Search GitHub repositories or code.',
    );
  }
  if (cfg.builtinAdapters.genericRss) {
    tools.rss = wrap(
      'rss',
      z.object({ url: trimmedURL }),
      async ({ url }) =>
        rssAdapter(url, {
          webFetch: (u) => webFetch({ url: u, cfg: cfg.fetch, hostAllowlist, privateNetworkHosts }),
        }),
      'Parse an RSS or Atom feed (URL host must be in the allowlist).',
    );
  }
  if (cfg.brave.apiKeys.length > 0) {
    const brave = new BraveClient(cfg.brave);
    tools.web_search = wrap(
      'web_search',
      z.object({
        query: trimmedQuery,
        siteFilter: z.string().trim().max(256).optional(),
      }),
      async ({ query, siteFilter }) => {
        const filter = siteFilter
          ? siteFilter.startsWith('site:') ? siteFilter : `site:${siteFilter}`
          : undefined;
        const r = await brave.search(query, filter);
        return wrapSearchResults(r.results);
      },
      'Run a Brave web search; returns up to maxResultsPerQuery {title,url,snippet} wrapped in <external-search-results>.',
    );
  }
  return tools;
}
