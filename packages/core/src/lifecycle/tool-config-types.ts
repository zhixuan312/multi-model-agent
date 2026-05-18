import type { AgentType } from '../types.js';
import type { ReportSchema } from '../reporting/structured-report-parser.js';
import type { HeadlineTemplate } from '../reporting/headline-composer.js';
import type { ReviewTemplate } from '../review/templates/shared.js';
import type { TaskSpec } from '../types.js';
import type { ExecutionContext } from './lifecycle-context.js';

/**
 * A briefSlot turns raw tool input into an array of briefs ready for the
 * generic executor. Each route owns its own briefSlot at
 * `tools/<route>/brief-slot.ts` (per the intake-dissolution cleanup; the
 * old shared `intake/brief-compiler.ts` location is gone).
 */
export type BriefSlotFiller<TInput, TBrief> = (input: TInput) => TBrief;

export interface ToolConfig<Input = unknown, Brief = unknown, Report = unknown> {
  name: string;
  category: 'artifact_producing' | 'read_only' | 'assist';
  /**
   * When true, tasks in the batch that share the same git toplevel (or
   * raw cwd when not in a git repo) run sequentially in caller input
   * order. Tasks in different repos still run in parallel across groups.
   * Defaults to false. Only write routes (delegate, execute-plan) opt in;
   * read-only routes leave it unset and keep full Promise.all fan-out.
   * See spec docs/superpowers/specs/2026-05-16-sequential-same-repo-dispatch-design.md.
   */
  serializeSameRepo?: boolean;
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
