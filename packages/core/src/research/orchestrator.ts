import type { QueryPlan } from './query-plan.js';
import {
  applyBudget, type EvidencePack, type EvidenceSource, type FailedAttempt,
  type SourceGroup,
} from './evidence-pack.js';
import type { AdapterId, AdapterResult } from './adapters/types.js';
import type { BraveSearchResponse, BraveSearchOptions } from './web-search.js';

export interface OrchestratorDeps {
  enabledAdapters: AdapterId[];
  brave:    { search: (query: string, options?: BraveSearchOptions) => Promise<BraveSearchResponse> };
  adapters: {
    arxiv:           (query: string)                         => Promise<AdapterResult[]>;
    semanticScholar: (query: string)                         => Promise<AdapterResult[]>;
    github:          (query: string, kind: 'repo' | 'code') => Promise<AdapterResult[]>;
    openalex:        (query: string)                         => Promise<AdapterResult[]>;
    crossref:        (query: string)                         => Promise<AdapterResult[]>;
    pubmed:          (query: string)                         => Promise<AdapterResult[]>;
  };
  perAdapterTimeoutMs:  number;
  totalDeadlineMs:      number;
  concurrencyCap:       number;
}

type Task =
  | { kind: 'brave';      query: string; freshness?: string; siteFilter?: string }
  | { kind: 'brave_news'; query: string; freshness?: string; siteFilter?: string }
  | { kind: 'arxiv';      query: string }
  | { kind: 'ss';         query: string }
  | { kind: 'gh_repo';    query: string }
  | { kind: 'gh_code';    query: string }
  | { kind: 'openalex';   query: string }
  | { kind: 'crossref';   query: string }
  | { kind: 'pubmed';     query: string };

const TASK_TO_GROUP: Record<Task['kind'], SourceGroup> = {
  brave:      'brave',
  brave_news: 'brave_news',
  arxiv:      'arxiv',
  ss:         'semantic_scholar',
  gh_repo:    'github_repo',
  gh_code:    'github_code',
  openalex:   'openalex',
  crossref:   'crossref',
  pubmed:     'pubmed',
};

function buildTasks(plan: QueryPlan): Task[] {
  const tasks: Task[] = [];
  for (const bq of plan.braveQueries) {
    const query = bq.siteFilter ? `${bq.siteFilter} ${bq.q}` : bq.q;
    if (bq.endpoint === 'news') {
      tasks.push({ kind: 'brave_news', query, freshness: bq.freshness, siteFilter: bq.siteFilter });
    } else {
      tasks.push({ kind: 'brave', query, freshness: bq.freshness, siteFilter: bq.siteFilter });
    }
  }
  for (const q of plan.arxivQueries)           tasks.push({ kind: 'arxiv',    query: q });
  for (const q of plan.semanticScholarQueries) tasks.push({ kind: 'ss',       query: q });
  for (const g of plan.githubQueries)
    tasks.push({ kind: g.kind === 'repo' ? 'gh_repo' : 'gh_code', query: g.q });
  for (const q of plan.openalexQueries)        tasks.push({ kind: 'openalex', query: q });
  for (const q of plan.crossrefQueries)        tasks.push({ kind: 'crossref', query: q });
  for (const q of plan.pubmedQueries)          tasks.push({ kind: 'pubmed',   query: q });
  return tasks;
}

function isAdapterEnabled(kind: Task['kind'], enabled: AdapterId[]): boolean {
  switch (kind) {
    case 'brave':
    case 'brave_news':     return true;
    case 'arxiv':          return enabled.includes('arxiv');
    case 'ss':             return enabled.includes('semantic_scholar');
    case 'gh_repo':
    case 'gh_code':        return enabled.includes('github_search');
    case 'openalex':       return enabled.includes('openalex');
    case 'crossref':       return enabled.includes('crossref');
    case 'pubmed':         return enabled.includes('pubmed');
  }
}

/** Per-adapter concurrency limits per spec (rate-limiting, timeouts, and error recovery). */
const ADAPTER_CONCURRENCY: Record<Task['kind'], number> = {
  brave:      5,
  brave_news: 5,
  openalex:   10,
  crossref:   5,
  pubmed:     2,  // 3 req/s hard limit without key; conservative
  arxiv:      1,  // arXiv asks for sequential access
  ss:         3,
  gh_repo:    3,
  gh_code:    3,
};

/** Simple semaphore for per-adapter concurrency control. */
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.running++;
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e); });
  });
}

async function runOne(
  task: Task, deps: OrchestratorDeps,
  sources: EvidenceSource[], fails: FailedAttempt[],
  semaphores: Map<Task['kind'], Semaphore>,
): Promise<void> {
  if (!isAdapterEnabled(task.kind, deps.enabledAdapters)) {
    fails.push({
      source: TASK_TO_GROUP[task.kind],
      query:  task.query,
      reason: 'no_api_key_configured',
    });
    return;
  }

  const queryStr = task.query;
  const sem = semaphores.get(task.kind)!;
  await sem.acquire();
  try {
    let raw: AdapterResult[] | BraveSearchResponse;
    switch (task.kind) {
      case 'brave':
      case 'brave_news': {
        const opts: BraveSearchOptions = {
          endpoint: task.kind === 'brave_news' ? 'news' : 'web',
          freshness: task.freshness,
          extraSnippets: true,
        };
        raw = await withTimeout(deps.brave.search(task.query, opts), deps.perAdapterTimeoutMs);
        break;
      }
      case 'arxiv':    raw = await withTimeout(deps.adapters.arxiv(task.query), deps.perAdapterTimeoutMs); break;
      case 'ss':       raw = await withTimeout(deps.adapters.semanticScholar(task.query), deps.perAdapterTimeoutMs); break;
      case 'gh_repo':  raw = await withTimeout(deps.adapters.github(task.query, 'repo'), deps.perAdapterTimeoutMs); break;
      case 'gh_code':  raw = await withTimeout(deps.adapters.github(task.query, 'code'), deps.perAdapterTimeoutMs); break;
      case 'openalex': raw = await withTimeout(deps.adapters.openalex(task.query), deps.perAdapterTimeoutMs); break;
      case 'crossref': raw = await withTimeout(deps.adapters.crossref(task.query), deps.perAdapterTimeoutMs); break;
      case 'pubmed':   raw = await withTimeout(deps.adapters.pubmed(task.query), deps.perAdapterTimeoutMs); break;
    }
    if (task.kind === 'brave' || task.kind === 'brave_news') {
      const br = raw as BraveSearchResponse;
      br.results.forEach((r, i) => {
        const snippetParts = [r.snippet];
        if (r.extraSnippets) snippetParts.push(...r.extraSnippets);
        sources.push({
          source: TASK_TO_GROUP[task.kind], query: queryStr,
          title: r.title, url: r.url,
          snippet: snippetParts.join('\n'),
          publishedAt: r.pageAge,
          rank: i,
        });
      });
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
  } finally {
    sem.release();
  }
}

export async function runOrchestrator(plan: QueryPlan, deps: OrchestratorDeps): Promise<EvidencePack> {
  const tasks = buildTasks(plan);
  const sources: EvidenceSource[] = [];
  const fails:   FailedAttempt[]  = [];

  // Per-adapter semaphores for concurrency enforcement
  const semaphores = new Map<Task['kind'], Semaphore>();
  for (const kind of Object.keys(ADAPTER_CONCURRENCY) as Array<Task['kind']>) {
    semaphores.set(kind, new Semaphore(ADAPTER_CONCURRENCY[kind]));
  }

  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      await runOne(tasks[idx]!, deps, sources, fails, semaphores);
    }
  };
  for (let i = 0; i < Math.min(deps.concurrencyCap, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return applyBudget(sources, fails);
}

export { ADAPTER_CONCURRENCY };
