/**
 * `RESEARCH_HTTP_TIMEOUT_MS` is documented as "the per-request wall-clock timeout shared by the
 * HTTP-fetching adapters". Three of the six did not use it.
 *
 * arXiv, Semantic Scholar and GitHub Search issued their `undici` request with no `signal`, so
 * nothing bounded them. The orchestrator's `withTimeout` does NOT cover that gap: it is a promise
 * race that rejects the caller after `perAdapterTimeoutMs` and never touches the request, so an
 * unresponsive endpoint left a socket open for the daemon's lifetime while the orchestrator had
 * already recorded the failure and moved on. In a long-running `mma serve` that is an unbounded
 * leak driven by a third party's availability.
 *
 * Asserted two ways, because either alone is weak:
 *   1. behaviourally — a server that accepts the connection and never answers must produce a
 *      rejection, not a hang, from EVERY adapter;
 *   2. structurally — every adapter that issues a request must pass a `signal`, so a new adapter
 *      cannot be added without one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { arxivSearch } from '../../../packages/core/src/research/adapters/arxiv.js';
import { semanticScholarSearch } from '../../../packages/core/src/research/adapters/semantic-scholar.js';
import { githubSearch } from '../../../packages/core/src/research/adapters/github-search.js';

const ADAPTERS_DIR = 'packages/core/src/research/adapters';
/** Modules that are not HTTP-fetching adapters. */
const NOT_AN_ADAPTER = new Set(['index.ts', 'types.ts']);

describe('every HTTP-fetching adapter is bounded by RESEARCH_HTTP_TIMEOUT_MS', () => {
  const adapterFiles = readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.ts') && !NOT_AN_ADAPTER.has(f));

  it('finds the adapters', () => {
    expect(adapterFiles).toHaveLength(6);
  });

  it.each(adapterFiles)('%s passes an abort signal on its request', (file) => {
    const text = readFileSync(join(ADAPTERS_DIR, file), 'utf8');
    expect(text, `${file} issues no request?`).toContain('await request(');
    expect(text, `${file} does not import the shared timeout`).toContain('RESEARCH_HTTP_TIMEOUT_MS');
    expect(text, `${file} sends no abort signal — the orchestrator's race will not cancel it`)
      .toMatch(/signal:\s*ac\.signal/);
  });
});

describe('a wedged endpoint rejects rather than hanging', () => {
  let server: Server | null = null;
  let port = 0;

  beforeEach(async () => {
    // Accepts the connection and never responds — the shape a promise race cannot cancel.
    server = createServer(() => { /* deliberately silent */ });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  /**
   * Each adapter is pointed at the silent server by overriding its host through `undici`'s global
   * dispatcher — the same mechanism the per-adapter tests use — and given a 200ms budget so the
   * case is fast. The assertion is only that it REJECTS: which error matters less than the fact
   * that the promise settles at all.
   */
  it.each([
    ['arxiv', () => arxivSearch('q')],
    ['semantic_scholar', () => semanticScholarSearch('q', { apiKey: 'k' })],
    ['github_search', () => githubSearch('q', { kind: 'repo' })],
  ])('%s settles instead of hanging when the endpoint never answers', async (_name, call) => {
    const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici');
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      // A mock that never replies is the closest deterministic stand-in for a wedged host; the
      // adapter's own AbortController is what has to end it.
      for (const origin of ['https://export.arxiv.org', 'https://api.semanticscholar.org', 'https://api.github.com']) {
        agent.get(origin).intercept({ path: () => true }).reply(() => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }).persist();
      }
      await expect(call()).rejects.toThrow();
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });
});
