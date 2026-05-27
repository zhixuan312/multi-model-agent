import { USER_AGENT } from '../user-agent.js';
import type { AdapterResult } from './types.js';

export interface GitHubOpts {
  kind: 'repo' | 'code';
  maxResults?: number;
  pat?: string;
}

interface GitHubRepoItem { id?: unknown; full_name?: unknown; html_url?: unknown; url?: unknown; description?: unknown; }
interface GitHubCodeItem { name?: unknown; path?: unknown; html_url?: unknown; url?: unknown; repository?: { full_name?: unknown; html_url?: unknown }; text_matches?: unknown; }

function isGitHubKind(kind: unknown): kind is GitHubOpts['kind'] {
  return kind === 'repo' || kind === 'code';
}

function firstTextMatchFragment(textMatches: unknown): string {
  if (!Array.isArray(textMatches)) return '';
  const fragment = textMatches[0]?.fragment;
  return typeof fragment === 'string' ? fragment : '';
}

export async function githubSearch(query: string, opts: GitHubOpts): Promise<AdapterResult[]> {
  if (!isGitHubKind(opts.kind)) throw new Error('github_invalid_kind');
  if (opts.kind === 'code' && (!opts.pat || opts.pat.length === 0)) {
    throw new Error('pat_required_for_code');
  }

  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const path = opts.kind === 'repo' ? '/search/repositories' : '/search/code';
  const url = new URL(`https://api.github.com${path}`);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', String(max));

  const accept = opts.kind === 'code'
    ? 'application/vnd.github.v3.text-match+json'
    : 'application/vnd.github+json';

  const headers: Record<string, string> = {
    accept,
    'user-agent': USER_AGENT,
  };
  if (opts.pat && opts.pat.length > 0) headers['authorization'] = `Bearer ${opts.pat}`;

  const res = await fetch(url.toString(), { method: 'GET', redirect: 'manual', headers });

  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error('github_rate_limited');
    try {
      const text = await res.text();
      const body = JSON.parse(text) as { message?: string };
      if (typeof body.message === 'string') {
        const msg = body.message.toLowerCase();
        if (msg.includes('rate limit') || msg.includes('abuse')) {
          throw new Error('github_rate_limited');
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'github_rate_limited') throw err;
    }
    throw new Error(`github_http_${res.status}`);
  }

  if (res.status >= 300 && res.status < 400) throw new Error('adapter_unexpected_redirect: github_search');
  if (res.status !== 200) throw new Error(`github_http_${res.status}`);

  let body: unknown;
  try { body = await res.json(); } catch { throw new Error('github_invalid_json'); }
  const items = typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items)
    ? body.items : [];

  if (opts.kind === 'repo') {
    return items.slice(0, max).map((raw: unknown) => {
      const item = raw as GitHubRepoItem;
      const recordId = typeof item.full_name === 'string' && item.full_name.length > 0
        ? item.full_name : String(item.id ?? '');
      return {
        adapterId: 'github_search' as const,
        recordId,
        title:    recordId,
        url:      String(item.html_url ?? item.url ?? ''),
        snippet:  String(item.description ?? '').slice(0, 500),
        raw:      item,
      };
    });
  }

  return items.slice(0, max).map((raw: unknown) => {
    const item = raw as GitHubCodeItem;
    const repoName = typeof item.repository?.full_name === 'string' ? item.repository.full_name : '';
    const filePath = typeof item.path === 'string' ? item.path : '';
    const fallbackId = String(item.url ?? item.html_url ?? '');
    const recordId = repoName || filePath ? `${repoName}:${filePath}` : fallbackId;
    const title    = repoName || filePath ? `${repoName} — ${filePath}` : fallbackId;
    const snippet  = firstTextMatchFragment(item.text_matches);
    return {
      adapterId: 'github_search' as const,
      recordId, title,
      url:     String(item.html_url ?? item.url ?? ''),
      snippet: snippet.slice(0, 500),
      raw:     item,
    };
  });
}
