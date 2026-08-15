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
import { REFINER_SCHEMAS } from '../../../packages/core/src/unified/refiner-schemas.js';
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

/**
 * The research prompt must name the adapters that exist.
 *
 * Its role line listed four — "arxiv, semantic_scholar, github_search, brave" — while the same
 * file's Query Phrasing section enumerates seven and the directory holds six adapters plus Brave
 * web search. A worker told it has four sources plans four sources: `openalex` (the broadest
 * academic index here, 250M+ works), `crossref` and `pubmed` were advertised nowhere in the
 * sentence that frames the whole job.
 */
describe('the research prompt names every adapter it can use', () => {
  const prompt = readFileSync('packages/core/src/skills/research/implement.md', 'utf8');
  const adapters = readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith('.ts') && !NOT_AN_ADAPTER.has(f))
    .map((f) => f.replace(/\.ts$/, '').replace(/-/g, '_'));

  it('finds the adapters', () => {
    expect(adapters.length).toBeGreaterThan(4);
  });

  it.each(adapters)('%s appears in the prompt', (adapter) => {
    // Accept either spelling: files are kebab-case, prompts use snake_case.
    const alt = adapter.replace(/_/g, '-');
    expect(
      prompt.includes(adapter) || prompt.includes(alt),
      `${adapter} is a wired adapter the prompt never mentions — the worker will not plan for it`,
    ).toBe(true);
  });
});

/**
 * The research prompt must permit the engine's own documented fallback.
 *
 * `preprocessors/research.ts` states: "On failure (unparseable plan, orchestrator error) the task
 * proceeds with LLM-only research", and returns `{}` so the implementer prompt carries no evidence
 * section at all. The prompt meanwhile said "cite from pre-fetched evidence, NEVER from training
 * data" and "no URL = no finding" — so in the fallback the only compliant output was
 * `findings: []`. "LLM-only research" was unreachable by construction, and the case bites any
 * install whose adapters all fail (no Brave key, for instance).
 */
describe('research handles the no-evidence-pack fallback', () => {
  const prompt = readFileSync('packages/core/src/skills/research/implement.md', 'utf8');

  it('the preprocessor still documents the fallback', () => {
    const pre = readFileSync('packages/server/src/application/preprocessors/research.ts', 'utf8');
    expect(pre).toMatch(/LLM-only research/);
  });

  it('the prompt names the state and forbids an empty report', () => {
    expect(prompt).toMatch(/No evidence pack/i);
    expect(prompt).toMatch(/Do NOT return an empty report/i);
  });

  it('it gives the worker a representable shape for an unsourced finding', () => {
    // url: "" must actually validate, or the instruction is another dead end.
    expect(prompt).toMatch(/url: ""/);
    const finding = {
      weight: 'medium', category: 'primary-sources', claim: 'c', evidence: 'e',
      url: '', source: 'model knowledge (no evidence pack)',
    };
    expect(
      REFINER_SCHEMAS.research!.safeParse({
        answer: 'no sources could be fetched', criteriaCovered: ['primary-sources'], findings: [finding],
      }).success,
    ).toBe(true);
  });
});

/**
 * The refiner must check every perspective the implementer reports.
 *
 * `research/review.md`'s evidence-coverage check listed four — primary, practitioner, recent,
 * counter-perspectives — while the implementer enumerates FIVE and its output block emits
 * `cross-domain` in `criteriaCovered`, which the route's goal condition also demands. So the one
 * perspective most likely to be skipped (lateral insight from an adjacent domain) was the one
 * nothing verified, and it was still reported as covered.
 */
describe('the research refiner checks all five perspectives', () => {
  const implement = readFileSync('packages/core/src/skills/research/implement.md', 'utf8');
  const review = readFileSync('packages/core/src/skills/research/review.md', 'utf8');

  /** Perspective slugs the implementer's own output example claims. */
  const perspectives = (() => {
    const block = /"criteriaCovered": \[([^\]]*)\]/.exec(implement);
    expect(block, 'the implementer output example moved').not.toBeNull();
    return [...block![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  })();

  it('finds the perspectives', () => {
    expect(perspectives.length).toBeGreaterThanOrEqual(4);
  });

  it.each(perspectives)('%s is verified by the refiner', (slug) => {
    // Accept the prose spelling as well as the slug — the refiner describes them in words.
    const words = slug.replace(/-/g, ' ');
    expect(
      review.includes(slug) || new RegExp(words, 'i').test(review),
      `the refiner never checks '${slug}', which the implementer reports as covered`,
    ).toBe(true);
  });
});
