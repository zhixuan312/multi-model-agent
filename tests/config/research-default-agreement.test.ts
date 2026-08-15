/**
 * The research defaults are written three times. They must all say the same thing.
 *
 * A Zod `.default()` value is returned as-is — it is NOT re-parsed through the schema, so a
 * block-level default literal cannot inherit the per-field `.default(...)` calls above it. That
 * is why `ResearchConfigSchema` states the same facts at three levels:
 *
 *   1. per field   — `arxiv: z.boolean().default(true)`        → used when the field is omitted
 *   2. per block   — `builtinAdapters: …default(() => ({ … }))` → used when the BLOCK is omitted
 *   3. per schema  — `ResearchConfigSchema.default(() => ({ … }))` → used when `research` is omitted
 *
 * Each level is reached by a different input, so a maintainer who changes one default sees their
 * change take effect on whichever shape they happened to test, and no test anywhere compared the
 * three. `research: {}` and no `research` key at all could silently return different configs.
 *
 * (Worth stating because it is easy to conclude the opposite: flipping a value in level 3 and
 * calling `ResearchConfigSchema.parse({})` shows NO change — not because the literal is inert,
 * but because passing `{}` is not passing `undefined`, so level 3 never fires. Level 2 answers
 * that call. The three levels need three different inputs to see.)
 */
import { describe, expect, it } from 'vitest';
import { ResearchConfigSchema, multiModelConfigSchema } from '../../packages/core/src/config/schema.js';

const AGENTS = {
  standard: { type: 'codex' as const, model: 'm' },
  complex: { type: 'codex' as const, model: 'm' },
  main: { type: 'codex' as const, model: 'm' },
};

describe('research config defaults agree at every level', () => {
  /** Level 1: every field omitted, both blocks present. */
  const perField = ResearchConfigSchema.parse({ brave: {}, builtinAdapters: {} });
  /** Level 2: both blocks omitted. */
  const perBlock = ResearchConfigSchema.parse({});
  /** Level 3: the whole `research` key omitted from a full config. */
  const perSchema = multiModelConfigSchema.parse({ agents: AGENTS }).research;

  it('the block default matches what the per-field defaults produce', () => {
    expect(perBlock).toEqual(perField);
  });

  it('the schema default matches what the per-field defaults produce', () => {
    expect(perSchema).toEqual(perField);
  });

  it('states the values once, here, so a change has one place to fail', () => {
    // Not a fourth copy to keep in sync — the three above are already pinned to each other, and
    // this one names them so a deliberate change is visible in the diff rather than silent.
    expect(perField).toEqual({
      brave: { apiKeys: [], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
      builtinAdapters: {
        arxiv: true, semanticScholar: true, githubSearch: true,
        openalex: true, crossref: true, pubmed: true,
      },
    });
  });
});
