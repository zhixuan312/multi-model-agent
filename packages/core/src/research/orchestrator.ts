//
// Step 2 of the /research pipeline. Deterministic Node-only fan-out across
// enabled adapters + Brave, with per-adapter timeout, concurrency cap scoped
// to this single call, and post-budget evidence pack assembly.

import type { QueryPlan } from './query-plan.js';
import {
  applyBudget, type EvidencePack, type EvidenceSource, type FailedAttempt,
  type SourceGroup,
} from './evidence-pack.js';
import type { AdapterId, AdapterResult } from './adapters/types.js';
import type { BraveSearchResponse } from './web-search.js';

export interface OrchestratorDeps {
  enabledAdapters: AdapterId[];
  brave:    { search: (query: string) => Promise<BraveSearchResponse> };
  adapters: {
    arxiv:           (query: string)                         => Promise<AdapterResult[]>;
    semanticScholar: (query: string)                         => Promise<AdapterResult[]>;
    github:          (query: string, kind: 'repo' | 'code') => Promise<AdapterResult[]>;
  };
  perAdapterTimeoutMs:  number;
  totalDeadlineMs:      number;
  concurrencyCap:       number;
}

type Task =
  | { kind: 'brave';     query: string }
  | { kind: 'arxiv';     query: string }
  | { kind: 'ss';        query: string }
  | { kind: 'gh_repo';   query: string }
  | { kind: 'gh_code';   query: string };

const TASK_TO_GROUP: Record<Task['kind'], SourceGroup> = {
  brave:   'brave',
  arxiv:   'arxiv',
  ss:      'semantic_scholar',
  gh_repo: 'github_repo',
  gh_code: 'github_code',
};

function buildTasks(plan: QueryPlan): Task[] {
  const tasks: Task[] = [];
  for (const q of plan.braveQueries)           tasks.push({ kind: 'brave',   query: q });
  for (const q of plan.arxivQueries)           tasks.push({ kind: 'arxiv',   query: q });
  for (const q of plan.semanticScholarQueries) tasks.push({ kind: 'ss',      query: q });
  for (const g of plan.githubQueries)
    tasks.push({ kind: g.kind === 'repo' ? 'gh_repo' : 'gh_code', query: g.q });
  return tasks;
}

function isAdapterEnabled(kind: Task['kind'], enabled: AdapterId[]): boolean {
  switch (kind) {
    case 'arxiv':           return enabled.includes('arxiv');
    case 'ss':              return enabled.includes('semantic_scholar');
    case 'gh_repo':
    case 'gh_code':         return enabled.includes('github_search');
    case 'brave':           return true;
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
  try {
    let raw: AdapterResult[] | BraveSearchResponse;
    switch (task.kind) {
      case 'brave':   raw = await withTimeout(deps.brave.search(task.query), deps.perAdapterTimeoutMs); break;
      case 'arxiv':   raw = await withTimeout(deps.adapters.arxiv(task.query), deps.perAdapterTimeoutMs); break;
      case 'ss':      raw = await withTimeout(deps.adapters.semanticScholar(task.query), deps.perAdapterTimeoutMs); break;
      case 'gh_repo': raw = await withTimeout(deps.adapters.github(task.query, 'repo'), deps.perAdapterTimeoutMs); break;
      case 'gh_code': raw = await withTimeout(deps.adapters.github(task.query, 'code'), deps.perAdapterTimeoutMs); break;
    }
    // Normalize each task's result to EvidenceSource[].
    if (task.kind === 'brave') {
      const br = raw as BraveSearchResponse;
      br.results.forEach((r, i) => sources.push({
        source: 'brave', query: queryStr,
        title: r.title, url: r.url, snippet: r.snippet, rank: i,
      }));
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
