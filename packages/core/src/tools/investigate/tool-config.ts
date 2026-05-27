import type { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { investigateReportSchema } from '../../reporting/report-parser-slots/investigate-report.js';
import type { InvestigateReportOutput } from '../../reporting/report-parser-slots/investigate-report.js';
import { investigateHeadlineTemplate } from '../../reporting/headline-templates/investigate.js';
import { deriveInvestigateWorkerStatus } from '../../reporting/derive-investigate-status.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { investigateBriefSlot, type EnrichedInvestigateInput, type InvestigateBrief } from './brief-slot.js';

// Re-export for external consumers (server handler imports
// EnrichedInvestigateInput from this module's path).
export type { EnrichedInvestigateInput, InvestigateBrief } from './brief-slot.js';

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


export const toolConfig: ToolConfig<EnrichedInvestigateInput, InvestigateBrief, InvestigateReportOutput> = {
  name: 'investigate',
  category: 'read_only',
  dispatchMode: 'parallel',
  dispatchModeOverridable: false,
  agentType: 'complex',
  briefSlot: investigateBriefSlot,
  buildTaskSpec: (brief: InvestigateBrief, ctx: ExecutionContext) => ({
    prompt: `Question: ${brief.question}`,
    readTarget: `Question: ${brief.question}`,
    agentType: 'complex' as const,
    reviewPolicy: 'none' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    filePaths: brief.filePaths,
    tools: brief.tools ?? ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    mainModel: ctx.mainModel ?? undefined,
  }),
  reportSchema: investigateReportSchema,
  headlineTemplate: investigateHeadlineTemplate,
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
