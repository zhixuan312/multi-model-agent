// packages/core/src/events/task-envelope.ts
// StructuredError lives on RunResult — re-define inline here to decouple events from run-result.
// Finding: existing in lifecycle/stage-io.ts but we keep a local minimal shape so events doesn't depend on lifecycle.
// EscalationEntry: existing as EscalationRecord on RunResult — local re-shape here.
// ValidationWarning: existing inline in TaskCompletedEventSchema — local re-shape here.

import type { EnvelopeBus } from './envelope-bus.js';

export interface StructuredError { code: string; message: string; where?: string }
export interface Finding { id: string; severity: 'critical'|'high'|'medium'|'low'; category: string; claim: string; evidence: string; suggestion?: string; source: 'implementer'|'reviewer' }
export interface EscalationEntry { fromModel: string; toModel: string; reason: string; atStage?: string }
export interface ValidationWarning { rule: string; path: string }

export type Route = 'delegate' | 'audit' | 'review' | 'debug' | 'investigate' | 'execute-plan' | 'retry' | 'research';
export type EnvelopeStatus = 'running' | 'done' | 'done_with_concerns' | 'failed';
export type StageName = 'implementing' | 'reviewing' | 'reworking' | 'annotating' | 'committing';
export type AgentTier = 'standard' | 'complex';

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
  findingsOutcome?: 'clean' | 'found' | 'not_applicable' | null;
  findingsOutcomeReason?: string | null;
  outcomeInferred?: boolean;
  outcomeMalformed?: boolean;
}

export interface ToolCallRecord {
  ts: string;
  stage: string;
  tool: string;
  filesRead: string[];
  filesWritten: string[];
}

export interface HeadlineSnapshot {
  prefix: string;
  stageLabel: string;
  stageDone: number;
  stageTotal: number;
  toolReads: number;
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
  // accumulated
  stages: StageRecord[];
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  filesWritten: string[];
  realFilesChanged: string[];
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
  escalationLog: EscalationEntry[];
  validationWarnings: ValidationWarning[];
  // derived
  headline: HeadlineSnapshot;
}

export interface CreateSeed {
  taskId: string; batchId: string; taskIndex: number;
  route: Route; agentType: AgentTier;
  client: string; mainModel: string; cwd: string;
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
      stages: [], toolCalls: [], filesRead: [], filesWritten: [], realFilesChanged: [],
      totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalCachedReadTokens: 0, totalCachedNonReadTokens: 0,
      totalDurationMs: 0, turnsUsed: 0, stallCount: 0, sandboxViolationCount: 0, taskMaxIdleMs: 0,
      findings: [], escalationLog: [], validationWarnings: [],
      headline: { prefix: '', stageLabel: 'queued', stageDone: 0, stageTotal: 0, toolReads: 0, toolWrites: 0, toolTotal: 0 },
    };
    store = new TaskEnvelopeStore(env, notify);
    store.recomputeHeadline();
    return store;
  }

  private guard(method: string) { if (this.sealed) throw new SealedEnvelopeError(method); }

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
      filesRead: [], filesWritten: entry.filesWritten ?? [],
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

  seal(terminal: { status: 'done' | 'done_with_concerns' | 'failed'; terminalAt?: string; stopReason: string | null; structuredError?: StructuredError | null; realFilesChanged: string[] }): void {
    this.guard('seal');
    this.env.status = terminal.status;
    this.env.terminalAt = terminal.terminalAt ?? new Date().toISOString();
    this.env.stopReason = terminal.stopReason;
    this.env.structuredError = terminal.structuredError ?? null;
    this.env.realFilesChanged = [...terminal.realFilesChanged];
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
    const stageNames = this.env.stages.map(s => s.name);
    const lastStage = this.env.stages[this.env.stages.length - 1];
    const reads = this.env.filesRead.length;
    const writes = this.env.filesWritten.length;
    // toolTotal is the count of recorded tool calls (run_shell, edit_file, …),
    // NOT reads+writes. Codex's run_shell commands pass empty file lists so
    // computing toolTotal from file counts only would report zero through an
    // entire investigation where the worker ran many shell commands.
    this.env.headline = {
      prefix: '',
      stageLabel: lastStage ? lastStage.name : 'queued',
      stageDone: this.env.stages.filter(s => s.outcome !== null).length,
      stageTotal: stageNames.length,
      toolReads: reads, toolWrites: writes, toolTotal: this.env.toolCalls.length,
    };
  }
}
