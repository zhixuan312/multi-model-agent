import type {
  MultiModelConfig,
  Provider,
  TaskType,
  ContractPlanSnapshot,
  DispatchedContractTask,
  SkillPair,
  TaskInput,
} from '@zhixuan92/multi-model-agent-core';
import type { SourceUsage } from '@zhixuan92/multi-model-agent-core/research';

/**
 * A preprocessor failure is a terminal, pre-pipeline task failure: the runtime
 * converts it into the standard six-key error envelope and fails the task
 * without opening any provider session.
 */
export class PreprocessFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PreprocessFailure';
  }
}

export interface PreprocessorArgs {
  taskId: string;
  cwd: string;
  /** The execution's abort signal — forwarded to any provider session a
   *  preprocessor opens (research query-plan turn) so pre-pipeline work sits
   *  inside the same cancellation scope as the pipeline itself. */
  signal: AbortSignal;
  /** The task payload (input minus control fields). Preprocessors may mutate it
   *  in place (candidate injection, outputPath derivation, component resolution). */
  payload: Record<string, unknown>;
  /** The full validated input (for fields excluded from the payload). */
  input: TaskInput;
  skills: SkillPair;
  config: MultiModelConfig;
  /** Resolved implementer provider (research query-plan generation). */
  implementerProvider: Provider;
}

export interface PreprocessResult {
  /** execute_plan / journal_record: labels the reviewer verifies for completeness. */
  dispatchedTasks?: string[];
  /** execute_plan: the authoritative id-keyed records the contract matcher resolves against.
   *  Distinct from `dispatchedTasks`, which is prompt prose the reviewer may paraphrase. */
  dispatchedContractTasks?: DispatchedContractTask[];
  /** execute_plan: frozen parsed Contract snapshot for acceptance-test scoring. */
  acceptanceTestSnapshot?: ContractPlanSnapshot;
  /** Progress denominator surfaced by the poll endpoint. */
  totalTasks?: number;
  /** Replacement skill pair when the preprocessor amended it (spec scope). */
  skills?: SkillPair;
  /** Markdown appended to the serialized payload (research evidence pack). */
  payloadSuffix?: string;
  /** Structured source-usage summary (research) for the telemetry envelope. */
  sourcesUsed?: SourceUsage[];
  /** Deterministic post-implementer apply hook (journal_record). */
  applyDecisions?: (implementerOutput: string) => Promise<{ recorded: unknown[]; failed: unknown[]; invariantsPassed: boolean }>;
}

export type Preprocessor = (args: PreprocessorArgs) => Promise<PreprocessResult>;

export type PreprocessorMap = Partial<Record<TaskType, Preprocessor>>;
