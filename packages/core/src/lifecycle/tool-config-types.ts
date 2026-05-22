import type { AgentType } from '../types.js';
import type { ReportSchema } from '../reporting/structured-report-parser.js';
import type { HeadlineTemplate } from '../reporting/headline-composer.js';
import type { TaskSpec } from '../types.js';
import type { ExecutionContext } from './lifecycle-context.js';

/**
 * A briefSlot turns raw tool input into an array of briefs ready for the
 * generic executor. Each route owns its own briefSlot at
 * `tools/<route>/brief-slot.ts` (per the intake-dissolution cleanup; the
 * old shared `intake/brief-compiler.ts` location is gone).
 */
export type BriefSlotFiller<TInput, TBrief> = (input: TInput) => TBrief;

/** Per-dispatch scheduling axis. Caller-chosen, not derived from repo membership. */
export type DispatchMode = 'serial' | 'parallel';

export interface ToolConfig<Input = unknown, Brief = unknown, Report = unknown> {
  name: string;
  category: 'artifact_producing' | 'read_only' | 'assist';
  /** Default dispatch mode for this route's multi-task batches. */
  dispatchMode: DispatchMode;
  /** When true, a per-dispatch caller override (request `execution` field) wins over `dispatchMode`. */
  dispatchModeOverridable: boolean;
  /** Agent tier to use when dispatching tasks for this tool. */
  agentType: AgentType;
  briefSlot: BriefSlotFiller<Input, Brief[]>;
  /** Converts a compiled brief into a TaskSpec. Called once per brief by the generic task executor. */
  buildTaskSpec: (brief: Brief, ctx: ExecutionContext, enrichedInput?: Input) => TaskSpec;
  reportSchema: ReportSchema<Report>;
  headlineTemplate: HeadlineTemplate;
  /** Optional per-tool envelope post-processing — e.g. autoRegisterContextBlock. */
  postProcessEnvelope?: (envelope: any, ctx: any) => Promise<any> | any;
}
