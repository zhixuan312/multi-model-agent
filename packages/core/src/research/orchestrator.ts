//
// Step 2 of the /research pipeline. Deterministic Node-only fan-out across
// enabled adapters + Brave + webFetch + RSS, with per-adapter timeout,
// concurrency cap scoped to this single call, allowlist enforcement on
// every outbound hop (directFetches + rssFeeds), and post-budget evidence
// pack assembly.

import type { QueryPlan } from './query-plan.js';
import {
  applyBudget, type EvidencePack, type EvidenceSource, type FailedAttempt,
  type SourceGroup,
} from './evidence-pack.js';
import type { AdapterId, AdapterResult } from './adapters/types.js';
import type { BraveSearchResponse } from './web-search.js';
import type { WebFetchResult } from './web-fetch.js';

export interface OrchestratorDeps {
  enabledAdapters: AdapterId[];
  brave:    { search: (query: string) => Promise<BraveSearchResponse> };
  adapters: {
    arxiv:           (query: string)                         => Promise<AdapterResult[]>;
    semanticScholar: (query: string)                         => Promise<AdapterResult[]>;
    github:          (query: string, kind: 'repo' | 'code') => Promise<AdapterResult[]>;
    rss:             (url: string)                            => Promise<AdapterResult[]>;
  };
  webFetch: (url: string) => Promise<WebFetchResult>;
  hostAllowlist:        Set<string>;
  perAdapterTimeoutMs:  number;
  totalDeadlineMs:      number;
  concurrencyCap:       number;
}

type Task =
  | { kind: 'brave';     query: string }
  | { kind: 'arxiv';     query: string }
  | { kind: 'ss';        query: string }
  | { kind: 'gh_repo';   query: string }
  | { kind: 'gh_code';   query: string }
  | { kind: 'rss';       url:   string }
  | { kind: 'fetch';     url:   string };

const TASK_TO_GROUP: Record<Task['kind'], SourceGroup> = {
  brave:   'brave',
  arxiv:   'arxiv',
  ss:      'semantic_scholar',
  gh_repo: 'github_repo',
  gh_code: 'github_code',
  rss:     'rss',
  fetch:   'web_fetch',
};

function buildTasks(plan: QueryPlan): Task[] {
  const tasks: Task[] = [];
  for (const q of plan.braveQueries)           tasks.push({ kind: 'brave',   query: q });
  for (const q of plan.arxivQueries)           tasks.push({ kind: 'arxiv',   query: q });
  for (const q of plan.semanticScholarQueries) tasks.push({ kind: 'ss',      query: q });
  for (const g of plan.githubQueries)
    tasks.push({ kind: g.kind === 'repo' ? 'gh_repo' : 'gh_code', query: g.q });
  for (const u of plan.rssFeeds)               tasks.push({ kind: 'rss',     url:   u });
  for (const u of plan.directFetches)          tasks.push({ kind: 'fetch',   url:   u });
  return tasks;
}

function isAdapterEnabled(kind: Task['kind'], enabled: AdapterId[]): boolean {
  switch (kind) {
    case 'arxiv':           return enabled.includes('arxiv');
    case 'ss':              return enabled.includes('semantic_scholar');
    case 'gh_repo':
    case 'gh_code':         return enabled.includes('github_search');
    case 'rss':             return enabled.includes('rss');
    case 'brave':           return true;
    case 'fetch':           return true;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e); });
  });
}

function isHostAllowed(url: string, allowlist: Set<string>): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowlist.has(host);
  } catch { return false; }
}

async function runOne(
  task: Task, deps: OrchestratorDeps,
  sources: EvidenceSource[], fails: FailedAttempt[],
): Promise<void> {
  if (!isAdapterEnabled(task.kind, deps.enabledAdapters)) {
    fails.push({
      source: TASK_TO_GROUP[task.kind],
      query:  'query' in task ? task.query : task.url,
      reason: 'no_api_key_configured',
    });
    return;
  }

  // Allowlist enforcement on outbound hops.
  if (task.kind === 'rss' || task.kind === 'fetch') {
    if (!isHostAllowed(task.url, deps.hostAllowlist)) {
      fails.push({
        source: TASK_TO_GROUP[task.kind],
        query:  task.url,
        reason: 'host_not_allowlisted',
      });
      return;
    }
  }

  const queryStr = 'query' in task ? task.query : task.url;
  try {
    let raw: AdapterResult[] | BraveSearchResponse | WebFetchResult;
    switch (task.kind) {
      case 'brave':   raw = await withTimeout(deps.brave.search(task.query), deps.perAdapterTimeoutMs); break;
      case 'arxiv':   raw = await withTimeout(deps.adapters.arxiv(task.query), deps.perAdapterTimeoutMs); break;
      case 'ss':      raw = await withTimeout(deps.adapters.semanticScholar(task.query), deps.perAdapterTimeoutMs); break;
      case 'gh_repo': raw = await withTimeout(deps.adapters.github(task.query, 'repo'), deps.perAdapterTimeoutMs); break;
      case 'gh_code': raw = await withTimeout(deps.adapters.github(task.query, 'code'), deps.perAdapterTimeoutMs); break;
      case 'rss':     raw = await withTimeout(deps.adapters.rss(task.url), deps.perAdapterTimeoutMs); break;
      case 'fetch':   raw = await withTimeout(deps.webFetch(task.url), deps.perAdapterTimeoutMs); break;
    }
    // Normalize each task's result to EvidenceSource[].
    if (task.kind === 'brave') {
      const br = raw as BraveSearchResponse;
      br.results.forEach((r, i) => sources.push({
        source: 'brave', query: queryStr,
        title: r.title, url: r.url, snippet: r.snippet, rank: i,
      }));
    } else if (task.kind === 'fetch') {
      const r = raw as WebFetchResult;
      if (r.status === 'ok') {
        sources.push({
          source: 'web_fetch', query: queryStr,
          title: `[fetched ${r.host}]`, url: queryStr,
          snippet: r.rawText.slice(0, 500), rank: 0,
        });
      } else {
        fails.push({ source: 'web_fetch', query: queryStr, reason: r.reasonCode });
      }
    } else {
      const arr = raw as AdapterResult[];
      arr.forEach((a, i) => sources.push({
        source: TASK_TO_GROUP[task.kind], query: queryStr,
        title: a.title, url: a.url, snippet: a.snippet,
        publishedAt: a.publishedAt, rank: i,
      }));
    }
  } catch (e) {
    fails.push({
      source: TASK_TO_GROUP[task.kind], query: queryStr,
      reason: (e as Error).message || 'unknown',
    });
  }
}

export async function runOrchestrator(plan: QueryPlan, deps: OrchestratorDeps): Promise<EvidencePack> {
  const tasks = buildTasks(plan);
  const sources: EvidenceSource[] = [];
  const fails:   FailedAttempt[]  = [];

  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      await runOne(tasks[idx]!, deps, sources, fails);
    }
  };
  for (let i = 0; i < Math.min(deps.concurrencyCap, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return applyBudget(sources, fails);
}
