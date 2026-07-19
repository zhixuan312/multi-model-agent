// Task envelope — the structured event store for a single task's lifecycle.
// Types are defined locally to decouple events/ from types/run-result.

import type { EnvelopeBus } from './envelope-bus.js';
import type { ErrorCode } from '../error-codes.js';
import type { FindingsOutcome } from '../types/enums.js';

export interface StructuredError { code: string; message: string; where?: string }
export interface Finding { id: string; severity: 'critical'|'high'|'medium'|'low'; category: string; claim: string; evidence: string; suggestion?: string; source: 'implementer'|'reviewer' }
export interface EscalationEntry { fromModel: string; toModel: string; reason: string; atStage?: string }
export interface ValidationWarning { rule: string; path: string }

export type Route = 'delegate' | 'audit' | 'review' | 'debug' | 'investigate' | 'execute-plan' | 'research' | 'journal-record' | 'journal-recall' | 'orchestrate' | 'spec' | 'plan';
export type EnvelopeStatus = 'running' | 'done' | 'done_with_concerns' | 'failed';
export type StageName = 'implementing' | 'reviewing' | 'reworking' | 'annotating' | 'committing';
export type AgentTier = 'standard' | 'complex' | 'main';

export interface StageRecord {
  name: StageName;
  round: number;
  outcome: 'advance' | 'concern' | 'fail' | 'skipped' | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  costUSD: number | null;
  model: string;
  tier: AgentTier;
  turnsUsed: number;
  filesWrittenCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number | null;
  cachedNonReadTokens: number | null;
  // route-specific (closed set per spec)
  filesCommittedCount?: number;
  branchCreated?: boolean;
  skipReason?: 'noop' | 'no_command' | 'not_applicable' | 'reviewPolicy_none';
  // Stage verdicts:
  //   review stage → 'approved' | 'changes_required' | 'error' (combined verdict
  //     of spec + quality sub-reviewers; matches wire enum, see wire-schema.ts).
  //   committing / verify stages → 'passed' | 'failed' | 'no_command' | 'annotated'
  //   annotating stage → tracked separately via `outcome` not `verdict`
  verdict?: 'passed' | 'failed' | 'no_command' | 'annotated' | 'approved' | 'changes_required' | 'concerns' | 'error';
  findingsBySeverity?: { critical: number; high: number; medium: number; low: number };
  concernCategories?: string[];
  // Findings outcome threading (review + implementing stages)
  findingsOutcome?: FindingsOutcome | null;
  findingsOutcomeReason?: string | null;
  outcomeInferred?: boolean;
  outcomeMalformed?: boolean;
}

export interface ToolCallRecord {
  ts: string;
  stage: string;
  tool: string;
  filesWritten: string[];
}

export interface HeadlineSnapshot {
  prefix: string;
  stageLabel: string;
  // 1-based ordinal of the stage named by stageLabel — i.e. how many visible
  // stages have *started* (the running one counts). Mirrors the heartbeat's
  // visibleRan, so `[stageIndex/stageTotal] stageLabel` reads as "stage N of
  // M, currently <label>". Not a count of completed stages.
  stageIndex: number;
  stageTotal: number;
  toolWrites: number;
  toolTotal: number;
}

export interface TaskEnvelope {
  // identity (immutable after creation)
  taskId: string;
  batchId: string;
  taskIndex: number;
  route: Route;
  agentType: AgentTier;
  client: string;
  mainModel: string;
  cwd: string;
  startedAt: string;
  // status
  status: EnvelopeStatus;
  terminalAt: string | null;
  stopReason: string | null;
  structuredError: StructuredError | null;
  errorCode: ErrorCode | null;
  reviewPolicy: 'reviewed' | 'none';
  plannedStageTotal: number;
  // accumulated
  stages: StageRecord[];
  toolCalls: ToolCallRecord[];
  filesWritten: string[];
  realFilesChanged: string[];
  // commit outcome (write routes) — set at seal() from the commit gate payload.
  // The response's structuredReport reads these so committed tasks surface their
  // real SHA/message; null on read routes and skipped commits.
  commitSha: string | null;
  commitMessage: string | null;
  commitSkipReason: string | null;
  // terminal context block (read routes) — set at seal() from the registered
  // terminal-report block id; null on write routes and on registration failure.
  contextBlockId: string | null;
  // totals
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedReadTokens: number;
  totalCachedNonReadTokens: number;
  totalDurationMs: number;
  turnsUsed: number;
  stallCount: number;
  sandboxViolationCount: number;
  taskMaxIdleMs: number;
  // findings/diagnostics
  findings: Finding[];
  // research-only: the `## Sources used` table (which adapter groups were
  // queried and which returned data), set at compose from the EvidencePack.
  // Empty on every non-research route.
  sourcesUsed: { source: string; attempted: boolean; used: boolean; note?: string }[];
  escalationLog: EscalationEntry[];
  validationWarnings: ValidationWarning[];
  // derived
  headline: HeadlineSnapshot;
}

export interface CreateSeed {
  taskId: string; batchId: string; taskIndex: number;
  route: Route; agentType: AgentTier;
  client: string; mainModel: string; cwd: string;
  reviewPolicy: 'reviewed' | 'none';
}

export class SealedEnvelopeError extends Error {
  constructor(method: string) { super(`TaskEnvelopeStore: cannot call ${method}() after seal()`); }
}

type Notify = (reason: string) => void;

export class TaskEnvelopeStore {
  private env: TaskEnvelope;
  private sealed = false;
  private notify: Notify;

  private constructor(env: TaskEnvelope, notify: Notify) {
    this.env = env;
    this.notify = notify;
  }

  static create(seed: CreateSeed, busOrNotify: EnvelopeBus | Notify = () => {}): TaskEnvelopeStore {
    if (seed.reviewPolicy === undefined) {
      throw new Error('TaskEnvelopeStore.create: reviewPolicy is required');
    }
    const notify: Notify = typeof busOrNotify === 'function'
      ? busOrNotify
      : (reason) => busOrNotify.emitEnvelopeSnapshot(store.snapshot(), reason);
    let store!: TaskEnvelopeStore;
    const env: TaskEnvelope = {
      taskId: seed.taskId, batchId: seed.batchId, taskIndex: seed.taskIndex,
      route: seed.route, agentType: seed.agentType,
      client: seed.client, mainModel: seed.mainModel, cwd: seed.cwd,
      startedAt: new Date().toISOString(),
      status: 'running', terminalAt: null, stopReason: null, structuredError: null,
      errorCode: null,
      reviewPolicy: seed.reviewPolicy,
      plannedStageTotal: 0,
      stages: [], toolCalls: [], filesWritten: [], realFilesChanged: [],
      commitSha: null, commitMessage: null, commitSkipReason: null,
      contextBlockId: null,
      totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalCachedReadTokens: 0, totalCachedNonReadTokens: 0,
      totalDurationMs: 0, turnsUsed: 0, stallCount: 0, sandboxViolationCount: 0, taskMaxIdleMs: 0,
      findings: [], sourcesUsed: [], escalationLog: [], validationWarnings: [],
      headline: { prefix: '', stageLabel: 'queued', stageIndex: 0, stageTotal: 0, toolWrites: 0, toolTotal: 0 },
    };
    store = new TaskEnvelopeStore(env, notify);
    store.recomputeHeadline();
    return store;
  }

  private guard(method: string) { if (this.sealed) throw new SealedEnvelopeError(method); }

  /**
   * Overwrite reviewPolicy after construction. Needed because async-dispatch
   * creates task 0's envelope before per-task TaskSpecs are known (the brief
   * slot runs inside the executor), so the initial seed is always the route
   * default. task-executor calls this once tasks[] is built so the wire
   * envelope reports per-task caller intent, not the dispatch-time default.
   * Without this, /delegate's per-task `reviewPolicy: 'none'` silently shows
   * up on the wire as 'full' — the dishonesty bug 4.7.7 was meant to close.
   */
  setReviewPolicy(policy: 'reviewed' | 'none'): void {
    this.guard('setReviewPolicy');
    if (this.env.reviewPolicy === policy) return;
    this.env.reviewPolicy = policy;
    this.notify('setReviewPolicy');
  }

  /**
   * Publish the planned count of visible stages for this run. The lifecycle
   * driver knows this up front (count of plan rows applicable to the route)
   * and lowers it as stages are skipped, mirroring the heartbeat's
   * `stageCount`. Lets the headline report a stable denominator instead of
   * counting stages as they get appended. No-ops when sealed (a late call
   * after teardown is harmless).
   */
  setPlannedStageTotal(n: number): void {
    if (this.sealed) return;
    if (this.env.plannedStageTotal === n) return;
    this.env.plannedStageTotal = n;
    this.recomputeHeadline();
    this.notify('setPlannedStageTotal');
  }

  startStage(name: StageName, init: { model: string; tier: AgentTier; startedAt?: string; round?: number }): void {
    this.guard('startStage');
    this.env.stages.push({
      name, round: init.round ?? 1, outcome: null,
      startedAt: init.startedAt ?? new Date().toISOString(), completedAt: null,
      durationMs: 0, costUSD: null, model: init.model, tier: init.tier,
      turnsUsed: 0, filesWrittenCount: 0,
      inputTokens: 0, outputTokens: 0, cachedReadTokens: null, cachedNonReadTokens: null,
    });
    this.recomputeHeadline();
    this.notify('startStage');
  }

  completeStage(name: StageName, round: number, result: Partial<StageRecord> & { outcome: StageRecord['outcome']; durationMs: number }): void {
    this.guard('completeStage');
    const stage = this.env.stages.find(s => s.name === name && s.round === round);
    if (!stage) throw new Error(`completeStage: no started stage ${name}@${round}`);
    Object.assign(stage, result, { completedAt: new Date().toISOString() });
    this.recomputeTotals();
    this.recomputeHeadline();
    this.notify('completeStage');
  }

  recordToolCall(entry: { stage: string; tool: string; filesWritten?: string[] }): void {
    this.guard('recordToolCall');
    const rec: ToolCallRecord = {
      ts: new Date().toISOString(), stage: entry.stage, tool: entry.tool,
      filesWritten: entry.filesWritten ?? [],
    };
    this.env.toolCalls.push(rec);
    for (const f of rec.filesWritten) if (!this.env.filesWritten.includes(f)) this.env.filesWritten.push(f);
    const last = this.env.stages[this.env.stages.length - 1];
    if (last) { last.filesWrittenCount = this.env.filesWritten.length; }
    this.recomputeHeadline();
    this.notify('recordToolCall');
  }

  recordEscalation(entry: EscalationEntry): void {
    this.guard('recordEscalation');
    this.env.escalationLog.push(entry);
    this.notify('recordEscalation');
  }

  recordStall(entry: { atMs: number; idleMs: number }): void {
    this.guard('recordStall');
    this.env.stallCount++;
    if (entry.idleMs > this.env.taskMaxIdleMs) this.env.taskMaxIdleMs = entry.idleMs;
    this.notify('recordStall');
  }

  recordSandboxViolation(entry: { kind: string; path: string }): void {
    this.guard('recordSandboxViolation');
    this.env.sandboxViolationCount++;
    this.notify('recordSandboxViolation');
  }

  recordFinding(f: Finding): void { this.guard('recordFinding'); this.env.findings.push(f); this.notify('recordFinding'); }
  recordSourcesUsed(rows: TaskEnvelope['sourcesUsed']): void { this.guard('recordSourcesUsed'); this.env.sourcesUsed = rows; this.notify('recordSourcesUsed'); }
  recordValidationWarning(w: ValidationWarning): void { this.guard('recordValidationWarning'); this.env.validationWarnings.push(w); this.notify('recordValidationWarning'); }
  recordHeartbeat(_state: { stallIdleMs: number }): void {
    // Heartbeats fire on a periodic timer that can race past seal(). Silently
    // no-op once sealed — other mutations (startStage, completeStage, recordX)
    // still throw because their callers should know they're operating on a
    // finalized envelope, but a stray heartbeat tick is harmless.
    if (this.sealed) return;
    this.recomputeHeadline();
    this.notify('recordHeartbeat');
  }

  seal(terminal: { status: 'done' | 'done_with_concerns' | 'failed'; terminalAt?: string; stopReason: string | null; structuredError?: StructuredError | null; errorCode?: ErrorCode | null; realFilesChanged: string[]; commitSha?: string | null; commitMessage?: string | null; commitSkipReason?: string | null; contextBlockId?: string | null }): void {
    this.guard('seal');
    this.env.status = terminal.status;
    this.env.terminalAt = terminal.terminalAt ?? new Date().toISOString();
    this.env.stopReason = terminal.stopReason;
    this.env.structuredError = terminal.structuredError ?? null;
    this.env.errorCode = terminal.errorCode ?? null;
    this.env.realFilesChanged = [...terminal.realFilesChanged];
    this.env.commitSha = terminal.commitSha ?? null;
    this.env.commitMessage = terminal.commitMessage ?? null;
    this.env.commitSkipReason = terminal.commitSkipReason ?? null;
    this.env.contextBlockId = terminal.contextBlockId ?? null;
    this.recomputeTotals();
    this.recomputeHeadline();
    this.sealed = true;
    this.notify('seal');
  }

  isSealed(): boolean { return this.sealed; }
  snapshot(): Readonly<TaskEnvelope> { return structuredClone(this.env); }

  private recomputeTotals(): void {
    let cost = 0, inT = 0, outT = 0, crT = 0, cnrT = 0, dur = 0, turns = 0;
    for (const s of this.env.stages) {
      cost += s.costUSD ?? 0;
      inT += s.inputTokens; outT += s.outputTokens;
      crT += s.cachedReadTokens ?? 0; cnrT += s.cachedNonReadTokens ?? 0;
      dur += s.durationMs; turns += s.turnsUsed;
    }
    this.env.totalCostUSD = cost;
    this.env.totalInputTokens = inT; this.env.totalOutputTokens = outT;
    this.env.totalCachedReadTokens = crT; this.env.totalCachedNonReadTokens = cnrT;
    this.env.totalDurationMs = dur; this.env.turnsUsed = turns;
  }

  private recomputeHeadline(): void {
    const lastStage = this.env.stages[this.env.stages.length - 1];
    // Count only stages that actually RAN — exclude skipped ones. env.stages
    // records every stage the driver touched, including stages skipped by the
    // current route (e.g. read-only routes skip review/rework/commit; an
    // artifact route skips commit when there's nothing to commit). A skipped
    // stage must not advance the displayed ordinal or inflate the denominator.
    // The currently-running stage has outcome null (started, not yet completed)
    // and so counts; a skipped stage has outcome 'skipped' and does not.
    const ran = this.env.stages.filter(s => s.outcome !== 'skipped').length;
    // toolTotal is the count of recorded tool calls (run_shell, edit_file, …),
    // NOT writes. Codex's run_shell commands pass empty file lists, so
    // computing toolTotal from file counts only would report zero through an
    // entire investigation where the worker ran many shell commands.
    this.env.headline = {
      prefix: '',
      stageLabel: lastStage ? lastStage.name : 'queued',
      // 1-based ordinal of the currently-running stage among the stages that
      // actually run (skipped stages don't count). Mirrors the heartbeat's
      // visibleRan so `[stageIndex/stageTotal] stageLabel` reads "stage N of M".
      stageIndex: ran,
      // Driver-published planned total (already decremented per skip) keeps the
      // denominator stable. max() guards the case where rework adds more rounds
      // than planned, so the ran-count can exceed the original estimate.
      stageTotal: Math.max(ran, this.env.plannedStageTotal),
      toolWrites: this.env.filesWritten.length, toolTotal: this.env.toolCalls.length,
    };
  }
}
