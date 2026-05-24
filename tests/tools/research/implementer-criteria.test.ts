import {
  TURN1_PLAN_PROMPT_TEMPLATE,
  RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE,
  RESEARCH_CRITERIA,
  CANONICAL_CATEGORY_IDS,
} from '../../../packages/core/src/tools/research/implementer-criteria.js';

describe('research implementer-criteria — 2-turn rewrite', () => {
  it('exposes exactly 5 canonical lowercase category ids', () => {
    expect(CANONICAL_CATEGORY_IDS).toEqual([
      'primary-sources', 'practitioner-consensus', 'recent-developments',
      'counter-perspectives', 'cross-domain',
    ]);
  });

  it('parsed RESEARCH_CRITERIA has 5 entries matching the canonical ids', () => {
    expect(RESEARCH_CRITERIA.length).toBe(5);
    // CriterionEntry has field `title` (NOT `label`); see types in
    // packages/core/src/tools/criteria-types.ts:8-22.
    const titles = RESEARCH_CRITERIA.map(c => c.title);
    for (const id of ['primary-sources','practitioner-consensus','recent-developments','counter-perspectives','cross-domain']) {
      expect(titles).toContain(id);
    }
  });

  it('TURN1 template names the structured-JSON requirement and the 4 query fields', () => {
    const t = TURN1_PLAN_PROMPT_TEMPLATE;
    expect(t).toMatch(/JSON/);
    for (const field of ['braveQueries','arxivQueries','semanticScholarQueries','githubQueries']) {
      expect(t).toContain(field);
    }
    // rss / web_fetch were removed from the research pipeline.
    expect(t).not.toContain('rssFeeds');
    expect(t).not.toContain('directFetches');
  });

  it('TURN1 template includes per-adapter cheatsheet hints', () => {
    const t = TURN1_PLAN_PROMPT_TEMPLATE;
    expect(t).toMatch(/arxiv/i);
    expect(t).toMatch(/site:|qualifier|stars:|language:/);
  });

  it('IMPLEMENTER_PREFIX template carries the EvidencePack placeholder and Sources-used contract', () => {
    const t = RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE;
    expect(t).toContain('<EVIDENCE_PACK_PLACEHOLDER>');
    expect(t).toContain('## Sources used');
    expect(t).toMatch(/source\s*\|\s*attempted\s*\|\s*used\s*\|\s*note/);
  });

  it('IMPLEMENTER_PREFIX template does NOT instruct the worker to call any tool', () => {
    const t = RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE;
    expect(t).not.toMatch(/use `web_search`/);
    expect(t).not.toMatch(/use `web_fetch`/);
    expect(t).not.toMatch(/call .*adapter/i);
  });
});
