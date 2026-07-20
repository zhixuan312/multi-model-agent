// Test-only stateful builder for TaskEnvelope objects.
//
// Production builds a TaskEnvelope in one shot via buildEnvelopeSnapshot()
// (packages/server/src/http/handlers/unified-task.ts). This fluent store is a
// test convenience for assembling well-formed envelopes step by step (create →
// startStage → completeStage → seal → snapshot) so wire/telemetry tests can
// exercise to-wire-record and the envelope bus without a full pipeline run.
//
// It lives under tests/ (not packages/core/src) because it has no production
// caller — keeping it out of the shipped library.

import type {
  TaskEnvelope,
  StageRecord,
  StageName,
  AgentTier,
  Route,
  Finding,
  EscalationEntry,
  ValidationWarning,
  ToolCallRecord,
  StructuredError,
} from '../../packages/core/src/events/task-envelope.js';
import type { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import type { ErrorCode } from '../../packages/core/src/error-codes.js';

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

  setReviewPolicy(policy: 'reviewed' | 'none'): void {
    this.guard('setReviewPolicy');
    if (this.env.reviewPolicy === policy) return;
    this.env.reviewPolicy = policy;
    this.notify('setReviewPolicy');
  }

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

  recordSandboxViolation(_entry: { kind: string; path: string }): void {
    this.guard('recordSandboxViolation');
    this.env.sandboxViolationCount++;
    this.notify('recordSandboxViolation');
  }

  recordFinding(f: Finding): void { this.guard('recordFinding'); this.env.findings.push(f); this.notify('recordFinding'); }
  recordSourcesUsed(rows: TaskEnvelope['sourcesUsed']): void { this.guard('recordSourcesUsed'); this.env.sourcesUsed = rows; this.notify('recordSourcesUsed'); }
  recordValidationWarning(w: ValidationWarning): void { this.guard('recordValidationWarning'); this.env.validationWarnings.push(w); this.notify('recordValidationWarning'); }
  recordHeartbeat(_state: { stallIdleMs: number }): void {
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
    const ran = this.env.stages.filter(s => s.outcome !== 'skipped').length;
    this.env.headline = {
      prefix: '',
      stageLabel: lastStage ? lastStage.name : 'queued',
      stageIndex: ran,
      stageTotal: Math.max(ran, this.env.plannedStageTotal),
      toolWrites: this.env.filesWritten.length, toolTotal: this.env.toolCalls.length,
    };
  }
}
