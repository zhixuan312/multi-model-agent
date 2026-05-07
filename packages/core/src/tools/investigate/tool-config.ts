import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityInvestigateTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { investigateReportSchema } from '../../reporting/report-parser-slots/investigate-report.js';
import type { InvestigateReportOutput } from '../../reporting/report-parser-slots/investigate-report.js';
import { investigateHeadlineTemplate } from '../../reporting/headline-templates/investigate.js';
import { deriveInvestigateWorkerStatus } from '../../reporting/derive-investigate-status.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerInvestigate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'investigate',
    httpMethod: 'POST',
    httpPath: '/investigate',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

// ── Enriched input: the handler resolves context blocks and canonicalizes
//    file paths before passing them here, so briefSlot operates on resolved data.

export interface ResolvedContextBlock {
  id: string;
  content: string;
}

export interface EnrichedInvestigateInput extends Input {
  resolvedContextBlocks: ResolvedContextBlock[];
  canonicalizedFilePaths: string[];
  relativeFilePathsForPrompt: string[];
}

export interface InvestigateBrief {
  question: string;
  prompt: string;
  filePaths: string[];
  contextBlockIds: string[];
  tools?: 'none' | 'readonly';
}

function compilePrompt(input: EnrichedInvestigateInput): string {
  const promptParts: string[] = [];
  promptParts.push(
    'Produce a narrative investigation report. Number each finding (1, 2, 3, ...). For each finding, on its own line, state Severity: critical|high|medium|low, then a one-paragraph explanation citing file:line for code-level claims (or describing what was searched for project-level claims). Optional Suggestion line. The reviewer will extract structured findings — do NOT emit JSON.',
  );
  for (const block of input.resolvedContextBlocks) {
    promptParts.push(block.content);
  }
  if (input.relativeFilePathsForPrompt.length > 0) {
    promptParts.push(
      'Anchor paths to start from (you may also read beyond these):\n' +
      input.relativeFilePathsForPrompt.map(p => `- ${p}`).join('\n'),
    );
  }
  promptParts.push(`Question: ${input.question}`);
  if (input.resolvedContextBlocks.length > 0) {
    promptParts.push(
      'A prior investigation report is provided as context above. Refine or extend that investigation. In your output, mark which prior unresolved questions you resolved this round and which remain open.',
    );
  }
  return promptParts.join('\n\n');
}

export const toolConfig: ToolConfig<EnrichedInvestigateInput, InvestigateBrief, InvestigateReportOutput> = {
  name: 'investigate',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input: EnrichedInvestigateInput): InvestigateBrief[] => {
    const prompt = compilePrompt(input);
    return [{
      question: input.question,
      prompt,
      filePaths: input.canonicalizedFilePaths,
      contextBlockIds: input.contextBlockIds ?? [],
      tools: input.tools,
    }];
  },
  buildTaskSpec: (brief: InvestigateBrief, ctx: ExecutionContext) => ({
    prompt: brief.prompt,
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    filePaths: brief.filePaths,
    tools: brief.tools ?? ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: investigateReportSchema,
  headlineTemplate: investigateHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityInvestigateTemplate,
  },
  postProcessEnvelope: (envelope, _ctx) => {
    const report = envelope.structuredReport as InvestigateReportOutput | undefined;
    const investigation = report?.kind === 'structured_report' ? report.investigation : null;
    const needsContext = investigation?.needsCallerClarification ?? false;

    const derived = deriveInvestigateWorkerStatus({
      needsContext,
      parseResult: report?.kind === 'structured_report'
        ? { kind: 'structured_report', investigation: report.investigation, sectionValidity: report.sectionValidity }
        : { kind: 'no_structured_report' },
    });

    // Attach investigation to the first result's structuredReport.
    if (investigation && envelope.results[0]) {
      if (!envelope.results[0].structuredReport) {
        (envelope.results[0] as any).structuredReport = { investigation };
      } else {
        (envelope.results[0].structuredReport as any).investigation = investigation;
      }
      (envelope.results[0] as any).workerStatus = derived.workerStatus;
      if (derived.incompleteReason !== undefined) {
        (envelope.results[0] as any).incompleteReason = derived.incompleteReason;
      }
    }

    return envelope;
  },
};
