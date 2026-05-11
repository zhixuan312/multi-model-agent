// Stage 4 handler — annotate-completion (pipeline-redesign §3.2.3, §3.2.4).
// 1. Runs task.verifyCommand deterministically.
// 2. Invokes standard-tier annotator (readonly) to produce structured JSON.
// 3. Parses; one retry on malformed.
// 4. Computes commitGatePercent = min(deterministic_backstop, annotatorPercent).
import { execFileSync } from 'node:child_process';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import { annotateCompletionTemplate } from '../../review/templates/annotate-completion.js';
import { parseAnnotatorOutput } from '../../reporting/annotate-completion-parser.js';

const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_OUTPUT_CAP_BYTES = 4096;

type VerifyResult = NonNullable<LifecycleState['completionAnnotation']>['verify'];

export function runVerifyCommand(cwd: string, command: string[] | undefined): VerifyResult {
  if (!Array.isArray(command) || command.length === 0) {
    return { ran: false, passed: null, exitCode: null, command: [], tailOutput: null };
  }
  try {
    const out = execFileSync(command[0]!, command.slice(1), {
      cwd,
      timeout: VERIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const tail = out.length > VERIFY_OUTPUT_CAP_BYTES ? out.slice(-VERIFY_OUTPUT_CAP_BYTES) : out;
    return { ran: true, passed: true, exitCode: 0, command, tailOutput: tail };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
    const stdout = (e.stdout ?? '').toString();
    const stderr = (e.stderr ?? '').toString();
    const combined = (stdout + stderr) || (e.message ?? String(err));
    const tail = combined.length > VERIFY_OUTPUT_CAP_BYTES ? combined.slice(-VERIFY_OUTPUT_CAP_BYTES) : combined;
    return {
      ran: true,
      passed: false,
      exitCode: typeof e.status === 'number' ? e.status : null,
      command,
      tailOutput: tail,
    };
  }
}

export function computeCommitGatePercent(
  annotatorPercent: number,
  parseSucceeded: boolean,
  filesWrittenCount: number,
  verifyPassed: boolean | null,
  perStep: Array<{ status: 'done' | 'partial' | 'missing' }>,
): number {
  let backstop = 0;
  if (filesWrittenCount > 0) backstop += 50;
  if (verifyPassed === true) backstop += 30;
  if (parseSucceeded && perStep.length > 0 && perStep.every(s => s.status !== 'missing')) backstop += 20;
  return Math.min(backstop, annotatorPercent);
}

function makeFallback(verifyResult: VerifyResult): NonNullable<LifecycleState['completionAnnotation']> {
  return {
    completionPercent: 0,
    perStep: [],
    verify: verifyResult,
    concerns: ['annotator failed to produce structured output; check state.completionAnnotationError'],
  };
}

export async function annotateCompletionHandler(state: LifecycleState): Promise<void> {
  if (state.reviewPolicy === 'none') return;
  if (state.terminal) return;
  if (state.completionAnnotation !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RunResult | undefined;
  if (!ctx || !task || !last) return;

  // 1. Run verify deterministically
  const verifyCommand = (task as { verifyCommand?: string[] }).verifyCommand;
  const verifyCwd = (task as { cwd?: string }).cwd ?? ctx.cwd;
  state.verifyResult = runVerifyCommand(verifyCwd, verifyCommand);

  // 2. Build annotator prompt
  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); }
    catch { cumulativeDiff = ''; }
  }
  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput: last.output ?? '',
    diff: cumulativeDiff,
    planContext: (task as { planContext?: string }).planContext,
    specReviewerNotes: state.specReviewerNotes ?? null,
    qualityReviewerNotes: state.qualityReviewerNotes ?? null,
    specReviewError: state.specReviewError ?? null,
    qualityReviewError: state.qualityReviewError ?? null,
    verifyResult: state.verifyResult as VerifyResult,
  };

  const annotatorTier: AgentType = ctx.assignedTier;  // standard
  const provider = ctx.providers[annotatorTier] as Provider | undefined;
  if (!provider) {
    state.completionAnnotationError = `no provider available for tier ${annotatorTier}`;
    state.completionAnnotation = makeFallback(state.verifyResult as VerifyResult);
    state.commitGatePercent = 0;
    return;
  }

  const basePrompt =
    annotateCompletionTemplate.systemPrompt + '\n\n' +
    annotateCompletionTemplate.buildUserPrompt(promptCtx);

  // 3. Up to 2 attempts (one retry on parse failure)
  let parsed: ReturnType<typeof parseAnnotatorOutput> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const promptToSend = attempt === 0
      ? basePrompt
      : basePrompt + '\n\n# Retry\nYour previous response did not match the schema. Reply with ONLY a single ```json ... ``` fenced block, no prose before or after.';
    let result: RunResult;
    try {
      result = await delegateWithEscalation(
        {
          prompt: promptToSend,
          cwd: ctx.cwd,
          agentType: annotatorTier,
          briefQualityPolicy: 'off',
          timeoutMs: ctx.timing.timeoutMs,
          // Pipeline-redesign §3.2.3: annotator is read-only. Explicit
          // here so the runner doesn't expose editor tools to a stage
          // whose job is to JUDGE the diff, not modify it.
          tools: 'readonly',
        },
        [provider],
        {
          explicitlyPinned: true,
          taskDeadlineMs: ctx.timing.deadlineMs,
          abortSignal: ctx.stall.controller.signal,
          assignedTier: annotatorTier,
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
          ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          stageLabel: attempt === 0 ? 'Annotating' : 'Annotating (retry)',
        },
      );
    } catch (err) {
      state.completionAnnotationError = err instanceof Error ? err.message : String(err);
      state.completionAnnotation = makeFallback(state.verifyResult as VerifyResult);
      state.commitGatePercent = 0;
      return;
    }
    if (result.status !== 'ok') {
      state.completionAnnotationError = `annotator returned status: ${result.status}`;
      state.completionAnnotation = makeFallback(state.verifyResult as VerifyResult);
      state.commitGatePercent = 0;
      return;
    }
    parsed = parseAnnotatorOutput(result.output);
    if (parsed.ok) break;
  }

  if (!parsed || !parsed.ok) {
    state.completionAnnotationError = parsed ? parsed.error : 'unknown parse failure';
    state.completionAnnotation = makeFallback(state.verifyResult as VerifyResult);
    state.commitGatePercent = 0;
    return;
  }

  // 4. Store annotation with verify overlay
  state.completionAnnotation = {
    completionPercent: parsed.value.completionPercent,
    perStep: parsed.value.perStep,
    verify: state.verifyResult as VerifyResult,
    concerns: parsed.value.concerns,
  };

  // 5. Compute commit-gate percent
  const filesWritten = (last.filesWritten ?? []) as string[];
  state.commitGatePercent = computeCommitGatePercent(
    parsed.value.completionPercent,
    true,
    filesWritten.length,
    (state.verifyResult as VerifyResult).passed,
    parsed.value.perStep,
  );
}
