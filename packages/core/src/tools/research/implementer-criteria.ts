// packages/core/src/tools/research/implementer-criteria.ts
//
// 2-turn /research worker prompts. Turn 1 plans queries (structured JSON);
// Turn 2 synthesises findings from a pre-fetched EvidencePack inlined in
// the prompt. The worker has tools: 'none'.

import type { CriterionEntry } from '../criteria-types.js';
import { parseCriteria } from '../criteria-types.js';

export const CANONICAL_CATEGORY_IDS = [
  'primary-sources',
  'practitioner-consensus',
  'recent-developments',
  'counter-perspectives',
  'cross-domain',
] as const;

const RESEARCH_FAILURE_MODES = [
  '1. primary-sources — Answers grounded in authoritative or original sources — papers (arxiv, semantic_scholar), official docs, maintainer-authored posts, RFCs. Cite source + section/line.',
  '2. practitioner-consensus — What practitioners actually do today — popular libraries (github), frequent SO patterns, top-rated GH issues, widely-cited blog posts.',
  '3. recent-developments — Sources from the last ~12 months — recent papers, recent commits to canonical repos, RFC drafts, recent maintainer announcements.',
  '4. counter-perspectives — Sources that challenge a default answer OR surface alternatives.',
  '5. cross-domain — How an adjacent domain solves the same shape of problem.',
].join('\n');

export const RESEARCH_CRITERIA: readonly CriterionEntry[] = parseCriteria(RESEARCH_FAILURE_MODES);

// ───────────────────────────── TURN 1: PLAN ─────────────────────────────

export const RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE = [
  'You are answering the user\'s research question against the evidence pack below.',
  '',
  'Research question:',
  '<RESEARCH_QUESTION_PLACEHOLDER>',
  '',
  'Background:',
  '<BACKGROUND_PLACEHOLDER>',
  '',
  '<EVIDENCE_PACK_PLACEHOLDER>',
  '',
  'For each criterion that follows, produce ONE finding for that perspective.',
  'Each finding must cite the source URL inline in its evidence text.',
  'After the LAST criterion, emit a `## Sources used` table covering every',
  'source you cited plus every entry from the "Sources that failed" block',
  'above (columns: `source | attempted | used | note`).',
].join('\n');

export const TURN1_PLAN_PROMPT_TEMPLATE = [
  'You are planning a /research call. The user wants:',
  '<RESEARCH_QUESTION_PLACEHOLDER>',
  '',
  'Background:',
  '<BACKGROUND_PLACEHOLDER>',
  '',
  'Your job in THIS turn is ONLY to emit a structured query plan as JSON.',
  'DO NOT answer the question yet. DO NOT search yet. ONLY plan queries.',
  '',
  'Required JSON shape (emit JSON ONLY, no prose):',
  '{',
  '  "braveQueries":           string[],  // 0..8 open-web search queries',
  '  "arxivQueries":           string[],  // 0..8 keywords for arxiv search',
  '  "semanticScholarQueries": string[],  // 0..8 keywords for semantic-scholar',
  '  "githubQueries":          [{ q: string, kind: "repo" | "code" }, ...],',
  '  "rssFeeds":               string[],  // 0..8 https RSS feed URLs',
  '  "directFetches":          string[]   // 0..8 https URLs on the allowlist',
  '}',
  '',
  'Per-adapter cheatsheet:',
  '- arxiv: use keyword AND/OR; field qualifiers (ti:, abs:, all:) work. Example: `ti:"stablecoin" AND abs:"design"`.',
  '- semantic_scholar: use natural keywords; no field syntax. Example: `stablecoin adoption mechanism`.',
  '- github repo: use qualifiers like `language:solidity stars:>50 topic:stablecoin`. Code search requires PAT (treat as may-fail).',
  '- brave: phrase as you would in a search engine; add `site:` filters for trusted domains.',
  '- rssFeeds and directFetches: only URLs on the operator-allowlist will be fetched; others are rejected at runtime.',
  '',
  'Constraints: ≤ 8 entries per list, ≤ 200 chars per query string.',
  'Empty arrays are allowed for sources you do not need.',
  '',
  'Emit ONLY the JSON object. No prose, no preamble, no code fences.',
].join('\n');

// Synthesis is carried by the existing read-route-implementer N-criterion
// loop after the EvidencePack is built. Each criterion's per-criterion
// suffix carries the perspective label and is appended to the prefix above
// when the loop runs (see read-route-implementer.ts).
