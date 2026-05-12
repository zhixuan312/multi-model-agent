import type { AgentType } from '../types.js';
import type { BriefSlotFiller } from '../intake/brief-compiler.js';
import type { ReportSchema } from '../reporting/structured-report-parser.js';
import type { HeadlineTemplate } from '../reporting/headline-composer.js';
import type { ReviewTemplate } from '../review/templates/shared.js';
import type { TaskSpec } from '../types.js';
import type { ExecutionContext } from './lifecycle-context.js';

export interface ToolConfig<Input = unknown, Brief = unknown, Report = unknown> {
  name: string;
  category: 'artifact_producing' | 'read_only' | 'assist';
  /** Agent tier to use when dispatching tasks for this tool. */
  agentType: AgentType;
  briefSlot: BriefSlotFiller<Input, Brief[]>;
  /** Converts a compiled brief into a TaskSpec. Called once per brief by the generic task executor. */
  buildTaskSpec: (brief: Brief, ctx: ExecutionContext) => TaskSpec;
  reportSchema: ReportSchema<Report>;
  headlineTemplate: HeadlineTemplate;
  reviewTemplates?: {
    spec?: ReviewTemplate;
    qualityAP?: ReviewTemplate;
    annotator?: ReviewTemplate;
  };
  /** Optional per-tool envelope post-processing — e.g. autoRegisterContextBlock. */
  postProcessEnvelope?: (envelope: any, ctx: any) => Promise<any> | any;
}
