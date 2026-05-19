import type { Input } from './schema.js';
import {
  EVIDENCE_RULE_RESEARCH,
  TRUST_BOUNDARY_USER_SOURCES_RESEARCH,
  TRUST_BOUNDARY_EXTERNAL_DATA_RESEARCH,
  QUERY_PHRASING_RESEARCH,
  strategyRuleResearch,
} from './implementer-criteria.js';

// Local definition — NOT imported from tool-config.ts (which used to define
// it, before this PR). The tools/investigate version is a different type
// for a different tool; do not share.
export interface ResolvedContextBlock { id: string; content: string; }

export interface EnrichedResearchInput extends Input {
  resolvedContextBlocks: ResolvedContextBlock[];
  /** Operator-configured source descriptors (research.userSources). */
  userSources: readonly string[];
  /** True iff research.brave.apiKeys is non-empty (drives the prompt branch
   *  that says "escalate to web_search"). */
  hasBrave: boolean;
}

export interface ResearchBrief {
  compiledPrompt: string;
  contextBlockIds: string[];
}

interface CompileExtras {
  userSources: readonly string[];
  hasBrave: boolean;
}

function compileResearchPrompt(
  input: Input,
  resolvedContextBlocks: ResolvedContextBlock[],
  extras: CompileExtras,
): string {
  const priorContext = resolvedContextBlocks.length
    ? `## Prior context (read-only)\n\n${resolvedContextBlocks.map(b => b.content).join('\n\n---\n\n')}\n\n`
    : '';

  const userSourcesBlock = extras.userSources.length
    ? extras.userSources.map((s, i) => `${i}. ${s}`).join('\n')
    : '(none configured)';

  return `${priorContext}You are an external researcher. The caller wants to discover external ideas, sources, and practices relevant to their question; your job is to bring back substantive external material with citations.

**Background:** ${input.background}
**Research question:** ${input.researchQuestion}

**User-described sources (free text — interpret each one):**
${userSourcesBlock}

${TRUST_BOUNDARY_USER_SOURCES_RESEARCH}

${strategyRuleResearch(extras.hasBrave)}

${TRUST_BOUNDARY_EXTERNAL_DATA_RESEARCH}

${QUERY_PHRASING_RESEARCH}

${EVIDENCE_RULE_RESEARCH}`;
}

export const researchBriefSlot = (input: EnrichedResearchInput): ResearchBrief[] => {
  const compiledPrompt = compileResearchPrompt(input, input.resolvedContextBlocks, {
    userSources: input.userSources,
    hasBrave: input.hasBrave,
  });
  return [{
    compiledPrompt,
    contextBlockIds: input.contextBlockIds ?? [],
  }];
};

// ── 2-turn additions (Task 11) ────────────────────────────────────────────
// `compileTurn1PlanPrompt` produces the QueryPlan-emitting prompt.
// `compileResearchImplementerPrefix` produces the implementer cachedPrefix
// that the existing read-route-implementer N-criterion loop consumes when
// /research is the route — embeds the question + EvidencePack so each of
// the 5 criterion sub-turns synthesises against the same evidence.

import {
  TURN1_PLAN_PROMPT_TEMPLATE,
  RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE,
} from './implementer-criteria.js';
import { serializeEvidencePack, type EvidencePack } from '../../research/evidence-pack.js';

export const TOTAL_PREFIX_BUDGET_BYTES = 96 * 1024;

export interface Turn1Inputs {
  researchQuestion: string;
  background?:      string;
}

export interface PrefixInputs {
  researchQuestion: string;
  background?:      string;
  pack:             EvidencePack;
  contextBlocks:    Array<{ id: string; content: string }>;
}

export function compileTurn1PlanPrompt(inp: Turn1Inputs): string {
  return TURN1_PLAN_PROMPT_TEMPLATE
    .replace('<RESEARCH_QUESTION_PLACEHOLDER>', inp.researchQuestion)
    .replace('<BACKGROUND_PLACEHOLDER>', inp.background ?? '(none)');
}

function trimToFitBudget(
  question: string, background: string, packMd: string, blocks: string,
): { prefix: string; trimNote: string } {
  const compose = (q: string, bg: string, pack: string, blks: string): string =>
    RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE
      .replace('<EVIDENCE_PACK_PLACEHOLDER>', pack + (blks ? '\n\n' + blks : ''))
      .replace('<RESEARCH_QUESTION_PLACEHOLDER>', q)
      .replace('<BACKGROUND_PLACEHOLDER>', bg);

  let prefix = compose(question, background, packMd, blocks);
  if (Buffer.byteLength(prefix, 'utf8') <= TOTAL_PREFIX_BUDGET_BYTES) {
    return { prefix, trimNote: '' };
  }
  let trimNote = '';
  // 1. Trim EvidencePack snippets.
  let trimmedPack = packMd;
  while (Buffer.byteLength(prefix, 'utf8') > TOTAL_PREFIX_BUDGET_BYTES && trimmedPack.length > 500) {
    trimmedPack = trimmedPack.slice(0, Math.floor(trimmedPack.length * 0.7));
    trimNote = '> _Note: evidence-pack snippets trimmed to fit prompt budget._';
    prefix = compose(question, background, trimmedPack + '\n…\n', blocks);
  }
  // 2. Trim contextBlocks.
  let trimmedBlocks = blocks;
  while (Buffer.byteLength(prefix, 'utf8') > TOTAL_PREFIX_BUDGET_BYTES && trimmedBlocks.length > 0) {
    trimmedBlocks = trimmedBlocks.slice(0, Math.floor(trimmedBlocks.length * 0.5));
    trimNote = '> _Note: context blocks trimmed to fit prompt budget._';
    prefix = compose(question, background, trimmedPack, trimmedBlocks);
  }
  // 3. Trim background.
  let trimmedBg = background;
  while (Buffer.byteLength(prefix, 'utf8') > TOTAL_PREFIX_BUDGET_BYTES && trimmedBg.length > 200) {
    trimmedBg = trimmedBg.slice(0, Math.floor(trimmedBg.length * 0.5)) + '…';
    trimNote = '> _Note: background trimmed to fit prompt budget._';
    prefix = compose(question, trimmedBg, trimmedPack, trimmedBlocks);
  }
  // 4. Hard guarantee: if still over budget, truncate prefix directly.
  if (Buffer.byteLength(prefix, 'utf8') > TOTAL_PREFIX_BUDGET_BYTES) {
    prefix = prefix.slice(0, TOTAL_PREFIX_BUDGET_BYTES);
    trimNote = '> _Note: prefix truncated to fit prompt budget._';
  }
  return { prefix, trimNote };
}

export function compileResearchImplementerPrefix(inp: PrefixInputs): string {
  const packMd = serializeEvidencePack(inp.pack);
  const blocksMd = inp.contextBlocks.length === 0
    ? ''
    : '## Context blocks\n\n' + inp.contextBlocks
        .map(b => `### ${b.id}\n\n${b.content}`).join('\n\n');
  const { prefix, trimNote } = trimToFitBudget(
    inp.researchQuestion, inp.background ?? '(none)', packMd, blocksMd,
  );
  return trimNote ? `${trimNote}\n\n${prefix}` : prefix;
}
