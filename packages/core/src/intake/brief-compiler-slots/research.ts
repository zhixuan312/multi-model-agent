import type { TaskSpec } from '../../types.js';
import type { Input } from '../../tools/research/schema.js';
import {
  EVIDENCE_RULE_RESEARCH,
  TRUST_BOUNDARY_USER_SOURCES_RESEARCH,
  TRUST_BOUNDARY_EXTERNAL_DATA_RESEARCH,
  QUERY_PHRASING_RESEARCH,
  strategyRuleResearch,
} from '../../tools/research/implementer-criteria.js';

export interface ResolvedContextBlock { id: string; content: string; }

export interface CompileExtras {
  userSources: readonly string[];
  hasBrave: boolean;
}

export interface CompileResearchResult {
  // Note: `route` is widened here because the RouteName union does not yet
  // include 'research' until Task 5 wires it in. `Omit<TaskSpec, 'route'>`
  // strips the original constraint so the intersection actually overrides
  // the type rather than narrowing to never. Once Task 5 lands, future
  // refactors can drop the Omit and use the real RouteName.
  task: Omit<TaskSpec, 'route'> & {
    route: string;
    originalInput: Record<string, unknown>;
  };
}

export function compileResearch(
  input: Input,
  resolvedContextBlocks: ResolvedContextBlock[],
  cwd: string,
  extras: CompileExtras,
): CompileResearchResult {
  const priorContext = resolvedContextBlocks.length
    ? `## Prior context (read-only)\n\n${resolvedContextBlocks.map(b => b.content).join('\n\n---\n\n')}\n\n`
    : '';

  const userSourcesBlock = extras.userSources.length
    ? extras.userSources.map((s, i) => `${i}. ${s}`).join('\n')
    : '(none configured)';

  const prompt = `${priorContext}You are an external researcher. The caller wants to discover external ideas, sources, and practices relevant to their question; your job is to bring back substantive external material with citations.

**Background:** ${input.background}
**Research question:** ${input.researchQuestion}

**User-described sources (free text — interpret each one):**
${userSourcesBlock}

${TRUST_BOUNDARY_USER_SOURCES_RESEARCH}

${strategyRuleResearch(extras.hasBrave)}

${TRUST_BOUNDARY_EXTERNAL_DATA_RESEARCH}

${QUERY_PHRASING_RESEARCH}

${EVIDENCE_RULE_RESEARCH}`;

  return {
    task: {
      route: 'research' as const,
      prompt,
      tools: 'readonly' as const,
      sandboxPolicy: 'cwd-only' as const,
      cwd,
      agentType: 'complex' as const,
      reviewPolicy: 'none' as const,
      originalInput: {
        researchQuestion: input.researchQuestion,
        background: input.background,
        contextBlockIds: input.contextBlockIds,
      } as Record<string, unknown>,
    },
  };
}
