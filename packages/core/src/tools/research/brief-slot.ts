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
