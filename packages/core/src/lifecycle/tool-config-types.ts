import type { BriefSlotFiller } from '../intake/brief-compiler.js';
import type { ReportSchema } from '../reporting/structured-report-parser.js';
import type { HeadlineTemplate } from '../reporting/headline-composer.js';
import type { ReviewTemplate } from '../review/templates/shared.js';

export interface ToolConfig<Input = unknown, Brief = unknown, Report = unknown> {
  name: string;
  category: 'artifact_producing' | 'read_only' | 'research' | 'assist';
  briefSlot: BriefSlotFiller<Input, Brief[]>;
  reportSchema: ReportSchema<Report>;
  headlineTemplate: HeadlineTemplate;
  reviewTemplates?: {
    spec?: ReviewTemplate;
    qualityAP?: ReviewTemplate;
    annotator?: ReviewTemplate;
    diff?: ReviewTemplate;
  };
  /** Optional per-tool envelope post-processing — e.g. autoRegisterContextBlock. */
  postProcessEnvelope?: (envelope: any, ctx: any) => Promise<any> | any;
}
