import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  ProgressEvent,
  RunTasksRuntime,
  AgentType,
  AgentCapability,
  BriefQualityWarning,
} from './types.js';
import { createProvider } from './provider.js';
import { resolveAgent } from './routing/resolve-agent.js';
import { delegateWithEscalation } from './delegate-with-escalation.js';
import { HeartbeatTimer } from './heartbeat.js';
import { expandContextBlocks } from './context/expand-context-blocks.js';
import { inferEffort } from './effort-inference.js';
import { evaluateReadiness } from './readiness/readiness.js';
import { runSpecReview } from './review/spec-reviewer.js';
import { runQualityReview } from './review/quality-reviewer.js';
import type { QualityReviewResult } from './review/quality-reviewer.js';
import { aggregateResult } from './review/aggregate-result.js';
import type { ParsedStructuredReport } from './reporting/structured-report.js';
import { parseStructuredReport } from './reporting/structured-report.js';
import fs from 'fs/promises';

const PLAN_CONTEXT_MAX_CHARS = 10_000;

export async function extractPlanSection(
  planFilePaths: string[],
  taskDescriptor: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  const basePath = cwd ?? process.cwd();

  for (const filePath of planFilePaths) {
    try {
      const resolved = filePath.startsWith('/') ? filePath : `${basePath}/${filePath}`;
      const content = await fs.readFile(resolved, 'utf-8');

      // Find the heading that matches the task descriptor
      const lines = content.split('\n');
      let startIndex = -1;
      let headingLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s+(.*)/);
        if (match && match[2].trim() === taskDescriptor.trim()) {
          startIndex = i;
          headingLevel = match[1].length;
          break;
        }
      }

      if (startIndex === -1) continue; // Try next file

      // Extract until next same-level or higher-level heading
      let endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s/);
        if (match && match[1].length <= headingLevel) {
          endIndex = i;
          break;
        }
      }

      let section = lines.slice(startIndex, endIndex).join('\n');
      if (section.length > PLAN_CONTEXT_MAX_CHARS) {
        section = section.slice(0, PLAN_CONTEXT_MAX_CHARS) + '\n[truncated at 10KB]';
      }
      return section;
    } catch {
      // File not readable — try next, or fall through to undefined
      if (process.env.MULTI_MODEL_DEBUG === '1') {
        console.error(`[multi-model-agent] plan file not readable: ${filePath}`);
      }
    }
  }

  return undefined;
}

export type RunTasksProgressCallback = (
  taskIndex: number,
  event: ProgressEvent,
) => void;

export interface RunTasksOptions {
  onProgress?: RunTasksProgressCallback;
  runtime?: RunTasksRuntime;
}

function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    error,
  };
}

type ResolvedTask =
  | { task: TaskSpec; resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } }
  | { task: TaskSpec; error: string; errorCode: string };

function withDoneCondition(task: TaskSpec): TaskSpec {
  if (!task.done) return task;
  return { ...task, prompt: `${task.prompt}\n\n## Success Criteria\n${task.done}` };
}

async function executeTask(
  resolved: Exclude<ResolvedTask, { error: string }>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  try {
    return await delegateWithEscalation(
      withDoneCondition(resolved.task),
      [resolved.resolved.provider],
      { explicitlyPinned: true, onProgress },
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

function extractWorkerStatus(
  report: ParsedStructuredReport | undefined,
): 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' {
  if (!report || !report.summary) return 'done';
  const s = report.summary.toLowerCase();
  if (s.includes('needs_context')) return 'needs_context';
  if (s.includes('blocked')) return 'blocked';
  if (s.includes('done_with_concerns') || s.includes('concerns')) return 'done_with_concerns';
  return 'done';
}

async function readImplementerFileContents(
  filesWritten: string[],
  cwd: string | undefined,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  const basePath = cwd ?? process.cwd();
  for (const filePath of filesWritten) {
    try {
      const resolved = filePath.startsWith('/') ? filePath : `${basePath}/${filePath}`;
      const content = await fs.readFile(resolved, 'utf-8');
      contents[filePath] = content.length > 50_000
        ? content.slice(0, 50_000) + '\n[truncated at 50KB]'
        : content;
    } catch {
      contents[filePath] = '[file not readable]';
    }
  }
  return contents;
}

function buildFallbackImplReport(result: RunResult): ParsedStructuredReport {
  const parsed = parseStructuredReport(result.output);
  if (parsed.summary) {
    return parsed;
  }
  return {
    summary: result.output.substring(0, 200),
    filesChanged: result.filesWritten.map(f => ({ path: f, summary: 'updated' })),
    validationsRun: [],
    deviationsFromBrief: [],
    unresolved: [],
  };
}

async function executeReviewedLifecycle(
  task: TaskSpec,
  resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean },
  config: MultiModelConfig,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  const reviewPolicy = task.reviewPolicy ?? 'full';
  const otherSlot: AgentType = resolved.slot === 'standard' ? 'complex' : 'standard';

  let escalationProvider: Provider | undefined;
  try {
    escalationProvider = createProvider(otherSlot, config);
  } catch {
    // Other slot not configured — auto-escalation not available
  }

  const stageCount = reviewPolicy === 'off' ? 1 : 5;
  const heartbeat = onProgress
    ? new HeartbeatTimer(onProgress)
    : undefined;
  heartbeat?.start(stageCount);

  const implModel = resolved.provider.config.model;

  const progressCounters = { filesRead: 0, filesWritten: 0, toolCalls: 0 };
  const wrappedOnProgress = onProgress
    ? (event: ProgressEvent) => {
        if (event.kind === 'tool_call') {
          heartbeat?.setInFlight(true);
          progressCounters.toolCalls++;
          const name = event.toolSummary.split('(')[0];
          if (name === 'readFile' || name === 'grep' || name === 'glob' || name === 'listFiles') {
            progressCounters.filesRead++;
          } else if (name === 'writeFile' || name === 'editFile') {
            progressCounters.filesWritten++;
          }
          heartbeat?.updateProgress(progressCounters.filesRead, progressCounters.filesWritten, progressCounters.toolCalls);
        }
        if (event.kind === 'turn_complete') {
          heartbeat?.setInFlight(false);
        }
        onProgress(event);
      }
    : undefined;

  try {
    // done is included in task.prompt below so the worker sees it as a goal.
    // The rework loop (below) then builds from task.prompt, so done is
    // implicitly preserved across all subsequent rounds.
    const implResult = await delegateWithEscalation(
      withDoneCondition(task),
      [resolved.provider],
      { explicitlyPinned: false, escalateToProvider: escalationProvider, onProgress: wrappedOnProgress },
    );

    const implReport = implResult.status === 'ok' ? parseStructuredReport(implResult.output) : undefined;
    const workerStatus = extractWorkerStatus(implReport);

    // C6a: filePaths interaction is a soft completion signal — review always runs.
    // If task.filePaths was provided, track whether the worker read or wrote any
    // of those paths as a completion concern (informational only).
    const filePathsInteracted = task.filePaths && task.filePaths.length > 0
      ? [...(implResult.filesRead ?? []), ...implResult.filesWritten].some(f =>
          task.filePaths!.some(fp => f === fp || f.endsWith('/' + fp) || f.endsWith(fp)),
        )
      : true;
    const filePathsSkipped = !filePathsInteracted;

    // Skip review entirely when the implementer produced no reviewable file artifacts.
    // This avoids sending the reviewer an empty packet that always fails to parse.
    heartbeat?.updateStageCount(1);
    if (implResult.filesWritten.length === 0) {
      const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);
      return {
        ...implResult,
        workerStatus,
        specReviewStatus: 'not_applicable',
        qualityReviewStatus: 'not_applicable',
        specReviewReason: 'task produced no file artifacts to review',
        qualityReviewReason: 'task produced no file artifacts to review',
        implementationReport: effectiveImplReport,
        structuredReport: {
          summary: '[No artifacts] task produced no file artifacts to review',
          filesChanged: effectiveImplReport.filesChanged,
          validationsRun: effectiveImplReport.validationsRun,
          deviationsFromBrief: effectiveImplReport.deviationsFromBrief,
          unresolved: effectiveImplReport.unresolved,
        },
        filePathsSkipped,
        agents: {
          implementer: resolved.slot,
          specReviewer: 'not_applicable',
          qualityReviewer: 'not_applicable',
        },
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
      };
    }

    if (workerStatus === 'needs_context' || workerStatus === 'blocked') {
      return {
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: worker reported ' + workerStatus,
        qualityReviewReason: 'skipped: worker reported ' + workerStatus,
        agents: {
          implementer: resolved.slot,
          specReviewer: 'skipped',
          qualityReviewer: 'skipped',
        },
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
      };
    }

    if (reviewPolicy === 'off') {
      return {
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: reviewPolicy is off',
        qualityReviewReason: 'skipped: reviewPolicy is off',
        agents: {
          implementer: resolved.slot,
          specReviewer: 'skipped',
          qualityReviewer: 'skipped',
        },
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
        implementationReport: implReport,
      };
    }

    let otherProvider: Provider;
    try {
      otherProvider = createProvider(otherSlot, config);
    } catch {
      return {
        ...implResult,
        workerStatus,
        specReviewStatus: 'skipped',
        qualityReviewStatus: 'skipped',
        specReviewReason: 'skipped: no review agent configured',
        qualityReviewReason: 'skipped: no review agent configured',
        agents: {
          implementer: resolved.slot,
          specReviewer: 'skipped',
          qualityReviewer: 'skipped',
        },
        models: {
          implementer: implModel,
          specReviewer: null,
          qualityReviewer: null,
        },
      };
    }

    const reviewModel = otherProvider.config.model;

    const packet = {
      prompt: task.prompt,
      scope: task.filePaths ?? [],
      doneCondition: task.done ?? 'tsc passes',
    };

    let fileContents = await readImplementerFileContents(implResult.filesWritten, task.cwd);

    const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);

    heartbeat?.setStage('spec_review', 2, 1, task.maxReviewRounds);

    let specResult = await runSpecReview(
      otherProvider,
      packet,
      effectiveImplReport,
      fileContents,
      implResult.toolCalls,
      task.planContext,
    );

    let finalImplResult = implResult;
    let finalImplReport = effectiveImplReport;
    let specStatus = specResult.status;
    let specReport = specResult.report;

    if (specStatus === 'changes_required') {
      let prevSpecFindings: string[] = [];
      let round = 0;
      while (true) {
        round++;
        heartbeat?.setStage('spec_rework', 3, round, task.maxReviewRounds ?? 10);
        const feedback = specResult.findings.length > 0
          ? `\n\n## Spec Review Feedback (round ${round}):\n${specResult.findings.map(f => `- ${f}`).join('\n')}`
          : '';
        const reworkPrompt = `${task.prompt}${feedback}`;
        const reworkTask = withDoneCondition({ ...task, prompt: reworkPrompt });

        const reworkResult = await delegateWithEscalation(
          reworkTask,
          [resolved.provider],
          { explicitlyPinned: true, onProgress: wrappedOnProgress },
        );

        finalImplResult = reworkResult;
        const reworkReport = parseStructuredReport(reworkResult.output);
        finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

        const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);
        fileContents = reworkContents;

        heartbeat?.setStage('spec_review', 2, round + 1, task.maxReviewRounds ?? 10);
        specResult = await runSpecReview(
          otherProvider,
          packet,
          finalImplReport,
          reworkContents,
          reworkResult.toolCalls,
          task.planContext,
        );

        specStatus = specResult.status;
        specReport = specResult.report;

        if (specStatus === 'approved') break;

        // Plateau detection: stop when same findings appear in two consecutive rounds.
        const currentFindings = [...specResult.findings].sort().join('\0');
        const prevFindings = prevSpecFindings.sort().join('\0');
        if (currentFindings === prevFindings && currentFindings !== '') break;

        prevSpecFindings = specResult.findings;

        // Absolute safety: don't exceed 10 rework rounds regardless.
        if (round >= (task.maxReviewRounds ?? 10)) break;
      }
    }

    let qualityResult: QualityReviewResult = { status: 'skipped', report: undefined, findings: [] };
    if (reviewPolicy === 'full') {
      heartbeat?.setStage('quality_review', 4, 1, task.maxReviewRounds ?? 10);
      qualityResult = await runQualityReview(
        otherProvider,
        packet,
        specReport ?? finalImplReport,
        fileContents,
        finalImplResult.toolCalls,
        finalImplResult.filesWritten,
      );

      if (qualityResult.status === 'changes_required') {
        let prevQualityFindings: string[] = [];
        let round = 0;
        while (true) {
          round++;
          heartbeat?.setStage('quality_rework', 5, round, task.maxReviewRounds ?? 10);
          const feedback = qualityResult.findings.length > 0
            ? `\n\n## Quality Review Feedback (round ${round}):\n${qualityResult.findings.map(f => `- ${f}`).join('\n')}`
            : '';
          const reworkPrompt = `${task.prompt}${feedback}`;
          const reworkTask = withDoneCondition({ ...task, prompt: reworkPrompt });

          const reworkResult = await delegateWithEscalation(
            reworkTask,
            [resolved.provider],
            { explicitlyPinned: true, onProgress: wrappedOnProgress },
          );

          finalImplResult = reworkResult;
          const reworkReport = parseStructuredReport(reworkResult.output);
          finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

          const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);

          heartbeat?.setStage('quality_review', 4, round + 1, task.maxReviewRounds ?? 10);
          qualityResult = await runQualityReview(
            otherProvider,
            packet,
            finalImplReport,
            reworkContents,
            reworkResult.toolCalls,
            reworkResult.filesWritten,
          );

          if (qualityResult.status === 'approved') break;

          const currentFindings = [...qualityResult.findings].sort().join('\0');
          const prevFindings = prevQualityFindings.sort().join('\0');
          if (currentFindings === prevFindings && currentFindings !== '') break;

          prevQualityFindings = qualityResult.findings;

          if (round >= (task.maxReviewRounds ?? 10)) break;
        }
      }
    }

    const finalReport = specReport ?? finalImplReport;

    const aggregated = aggregateResult(
      finalReport,
      specReport,
      qualityResult.report,
      specStatus,
      qualityResult.status,
    );

    return {
      ...finalImplResult,
      workerStatus,
      specReviewStatus: specStatus,
      qualityReviewStatus: qualityResult.status,
      specReviewReason: specResult.errorReason,
      qualityReviewReason: qualityResult.errorReason,
      structuredReport: aggregated,
      implementationReport: finalImplReport,
      specReviewReport: specReport,
      qualityReviewReport: qualityResult.report,
      filePathsSkipped,
      agents: {
        implementer: resolved.slot,
        specReviewer: otherSlot,
        qualityReviewer: reviewPolicy === 'full' ? otherSlot : 'skipped',
      },
      models: {
        implementer: implModel,
        specReviewer: reviewModel,
        qualityReviewer: reviewPolicy === 'full' ? reviewModel : null,
      },
    };
  } finally {
    heartbeat?.stop();
  }
}

export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
  options: RunTasksOptions = {},
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const expandedTasks: (TaskSpec | { error: string })[] = tasks.map((task) => {
    try {
      return expandContextBlocks(task, options.runtime?.contextBlockStore);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  const readinessResults = expandedTasks.map((entry) => {
    if ('error' in entry) return undefined;
    const task = entry as TaskSpec;
    if (task.briefQualityPolicy === 'off') {
      return { action: 'ignored' as const, missingPillars: [], layer2Warnings: [], layer3Hints: [], briefQualityWarnings: [] };
    }
    return evaluateReadiness(task, task.briefQualityPolicy ?? 'warn');
  });

  const refusedResults = expandedTasks.map((entry, idx) => {
    if ('error' in entry) return undefined;
    const readiness = readinessResults[idx];
    if (!readiness) return undefined;
    if (readiness.action === 'refuse') {
      return {
        output: `Brief too vague: missing ${readiness.missingPillars.join(', ')}`,
        status: 'brief_too_vague' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        filesRead: [] as string[],
        filesWritten: [] as string[],
        toolCalls: [] as string[],
        outputIsDiagnostic: true,
        escalationLog: [] as RunResult['escalationLog'],
        errorCode: 'brief_too_vague',
        briefQualityWarnings: readiness.briefQualityWarnings as BriefQualityWarning[],
        retryable: false,
      };
    }
    return undefined;
  });

  const resolved: ResolvedTask[] = expandedTasks.map((entry, idx): ResolvedTask => {
    if ('error' in entry) {
      return { task: tasks[idx], error: entry.error, errorCode: 'context_block_not_found' };
    }
    const task = entry;
    const agentType: AgentType = task.agentType ?? 'standard';
    try {
      const resolved_agent = resolveAgent(
        agentType,
        (task.requiredCapabilities ?? []) as AgentCapability[],
        config,
      );
      return { task, resolved: resolved_agent };
    } catch (err) {
      return {
        task,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'capability_missing',
      };
    }
  });

  // C5: Apply effort default when not explicitly set
  for (const r of resolved) {
    if ('error' in r) continue;
    if (r.task.effort === undefined) {
      const inferred = inferEffort(r.task.prompt);
      if (inferred !== undefined) {
        r.task = { ...r.task, effort: inferred };
      }
    }
  }

  // C3: Inject parallel-safety suffix when dispatching 2+ tasks
  if (resolved.length > 1) {
    const PARALLEL_SAFETY_SUFFIX =
      '\n\nYou are running in parallel with other tasks. ' +
      'Do NOT run full-project build commands (`npm run build`, `tsc`, `cargo build`). ' +
      'Only run task-specific test commands if provided.';

    for (const r of resolved) {
      if ('error' in r) continue;
      r.task = {
        ...r.task,
        prompt: r.task.prompt + PARALLEL_SAFETY_SUFFIX +
          (r.task.testCommand ? `\nTo verify your work, run: \`${r.task.testCommand}\`` : ''),
      };
    }
  }

  return Promise.all(
    resolved.map((r, index): Promise<RunResult> => {
      if ('error' in r) {
        return Promise.resolve({ ...errorResult(r.error), errorCode: r.errorCode });
      }
      const refused = refusedResults[index];
      if (refused) {
        return Promise.resolve(refused);
      }
      const taskProgress = options.onProgress
        ? (event: ProgressEvent) => options.onProgress!(index, event)
        : undefined;

      const readiness = readinessResults[index];
      return executeReviewedLifecycle(r.task, r.resolved, config, taskProgress).then(
        (result) => {
          if (readiness && readiness.briefQualityWarnings.length > 0) {
            return { ...result, briefQualityWarnings: readiness.briefQualityWarnings };
          }
          return result;
        },
      );
    }),
  );
}
