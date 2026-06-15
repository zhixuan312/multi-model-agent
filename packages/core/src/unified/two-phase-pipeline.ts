import type { Provider, Session, TurnResult } from '../types/run-result.js';
import type { AgentType } from '../types/task-spec.js';
import type { TaskType, SandboxPolicy } from './type-registry.js';

const CWD_ONLY_DISALLOWED_TOOLS = ['Agent', 'EnterWorktree', 'ExitWorktree'];
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
  /** Goal condition for the implementer — keeps the agent working until met. */
  implementerGoal?: string;
  /** Goal condition for the reviewer. */
  reviewerGoal?: string;
  /** EnvelopeBus for provider-level event streaming (stderr + JSONL + telemetry). */
  bus?: object;
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

function extractStructuredBlock(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  return raw;
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

  // --- Rewrite file paths in the payload to use the worktree cwd ---
  // When a worktree is active, the taskPayload may contain absolute paths
  // referencing the original cwd (e.g. plan file paths). The implementer's
  // session cwd is the worktree, so it will infer the repo root from those
  // paths and write files to the original repo instead of the worktree.
  // Rewriting the paths removes this ambiguity.
  let effectivePayload = input.taskPayload;
  if (effectiveCwd !== input.cwd) {
    effectivePayload = input.taskPayload.replaceAll(input.cwd, effectiveCwd);
  }

  const sessions: Session[] = [];

  // --- Worktree merge + cleanup helper ---
  const resolveWorktree = async (): Promise<WorktreeInfo | null> => {
    if (!wtManager || !wtInfo) return null;
    return wtManager.mergeAndCleanup(wtInfo.path, wtInfo.branch, input.cwd);
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
      taskId: input.taskId ?? 'pipeline',
      taskIndex: 0,
      bus: input.bus,
      ...(input.resumeImplementer && { resume: input.resumeImplementer }),
      ...(input.sandboxPolicy === 'cwd-only' && { disallowedTools: CWD_ONLY_DISALLOWED_TOOLS }),
    });
    sessions.push(implSession);

    const implPrompt = `${input.implementerSkill}\n\n---\n\n## Task\n\n${effectivePayload}`;
    const implTurn = await implSession.send(implPrompt, {
      ...(input.implementerGoal && { goalCondition: input.implementerGoal }),
    });
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

    // Reviewer runs in the original cwd, not the worktree — it only reads
    // the implementer's output text and doesn't need worktree file access.
    // Using original cwd also avoids ENOENT crashes if the worktree's temp
    // directory is cleaned by the OS during a long-running implementer.
    const revSession = input.reviewerProvider.openSession({
      cwd: input.cwd,
      wallClockDeadline: deadline,
      abortSignal: ac.signal,
      taskId: input.taskId ?? 'pipeline',
      taskIndex: 1,
      bus: input.bus,
      ...(input.resumeReviewer && { resume: input.resumeReviewer }),
    });
    sessions.push(revSession);

    const revPrompt = `${input.reviewerSkill}\n\n---\n\n## Implementer Output\n\n${extractStructuredBlock(implTurn.output)}`;
    const revTurn = await revSession.send(revPrompt, {
      ...(input.reviewerGoal && { goalCondition: input.reviewerGoal }),
    });
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
