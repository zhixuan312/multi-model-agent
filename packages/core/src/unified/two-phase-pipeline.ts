import type { Provider, Session, TurnResult } from '../types/run-result.js';
import type { AgentType } from '../types/task-spec.js';
import type { TaskType, SandboxPolicy } from './type-registry.js';
import { parseReviewerOutput, type ReviewerOutput } from './reviewer-output-parser.js';
import { WorktreeManager, type WorktreeInfo } from './worktree-manager.js';

export interface PipelineInput {
  type: TaskType;
  implementerSkill: string;
  reviewerSkill: string;
  taskPayload: string;
  implementerProvider: Provider;
  reviewerProvider: Provider;
  implementerTier: AgentType;
  reviewerTier: AgentType;
  reviewPolicy: 'reviewed' | 'none';
  cwd: string;
  sandboxPolicy: SandboxPolicy;
  resumeImplementer?: string;
  resumeReviewer?: string;
  timeoutMs?: number;
  worktreeEnabled?: boolean;
  taskId?: string;
}

export interface SessionInfo {
  tier: AgentType;
  sessionId: string | null;
  resumeSupported: boolean;
}

export interface PipelineResult {
  status: 'done' | 'done_with_concerns' | 'failed';
  implementerOutput: string;
  implementerTurn: TurnResult;
  reviewerOutput: ReviewerOutput | null;
  reviewerRaw: string | null;
  reviewerTurn: TurnResult | null;
  reviewerParseError: string | null;
  sessions: {
    implementer: SessionInfo;
    reviewer: SessionInfo | null;
  };
  cost: {
    implementerUsd: number;
    reviewerUsd: number | null;
  };
  worktree: WorktreeInfo | null;
}

export async function runTwoPhasePipeline(input: PipelineInput): Promise<PipelineResult> {
  const ac = new AbortController();
  const deadline = Date.now() + (input.timeoutMs ?? 3_600_000);

  // --- Worktree setup ---
  let effectiveCwd = input.cwd;
  let wtManager: WorktreeManager | undefined;
  let wtInfo: { branch: string; path: string } | undefined;

  if (input.worktreeEnabled && input.taskId) {
    wtManager = new WorktreeManager();
    const created = await wtManager.create(input.cwd, input.taskId, input.type);
    effectiveCwd = created.path;
    wtInfo = { branch: created.branch, path: created.path };
  }

  const sessions: Session[] = [];

  // --- Worktree cleanup helper ---
  const resolveWorktree = async (): Promise<WorktreeInfo | null> => {
    if (!wtManager || !wtInfo) return null;
    const preserved = await wtManager.cleanup(wtInfo.path, wtInfo.branch);
    return { branch: wtInfo.branch, path: wtInfo.path, hasChanges: preserved };
  };

  // Close all opened sessions — best-effort, errors swallowed.
  const closeSessions = async (): Promise<void> => {
    await Promise.allSettled(sessions.map(s => s.close()));
  };

  try {
    const implSession = input.implementerProvider.openSession({
      cwd: effectiveCwd,
      wallClockDeadline: deadline,
      abortSignal: ac.signal,
      batchId: input.taskId ?? 'pipeline',
      taskIndex: 0,
    });
    sessions.push(implSession);

    const implPrompt = `${input.implementerSkill}\n\n---\n\n## Task\n\n${input.taskPayload}`;
    const implTurn = await implSession.send(implPrompt);
    const implId = implSession.getSessionId();

    if (input.reviewPolicy === 'none') {
      const worktree = await resolveWorktree();
      return {
        status: 'done',
        implementerOutput: implTurn.output,
        implementerTurn: implTurn,
        reviewerOutput: null,
        reviewerRaw: null,
        reviewerTurn: null,
        reviewerParseError: null,
        sessions: {
          implementer: { tier: input.implementerTier, sessionId: implId, resumeSupported: implId !== null },
          reviewer: null,
        },
        cost: { implementerUsd: implTurn.costUSD, reviewerUsd: null },
        worktree,
      };
    }

    const revSession = input.reviewerProvider.openSession({
      cwd: effectiveCwd,
      wallClockDeadline: deadline,
      abortSignal: ac.signal,
      batchId: input.taskId ?? 'pipeline',
      taskIndex: 1,
    });
    sessions.push(revSession);

    const revPrompt = `${input.reviewerSkill}\n\n---\n\n## Implementer Output\n\n${implTurn.output}`;
    const revTurn = await revSession.send(revPrompt);
    const revId = revSession.getSessionId();

    const parsed = parseReviewerOutput(revTurn.output);

    const worktree = await resolveWorktree();

    return {
      status: parsed.ok ? 'done' : 'done_with_concerns',
      implementerOutput: implTurn.output,
      implementerTurn: implTurn,
      reviewerOutput: parsed.ok ? parsed.data : null,
      reviewerRaw: revTurn.output,
      reviewerTurn: revTurn,
      reviewerParseError: parsed.ok ? null : parsed.error,
      sessions: {
        implementer: { tier: input.implementerTier, sessionId: implId, resumeSupported: implId !== null },
        reviewer: { tier: input.reviewerTier, sessionId: revId, resumeSupported: revId !== null },
      },
      cost: { implementerUsd: implTurn.costUSD, reviewerUsd: revTurn.costUSD },
      worktree,
    };
  } finally {
    await closeSessions();
  }
}
