import type {
  Provider,
  RunResult,
  TaskSpec,
  MultiModelConfig,
  AgentType,
} from '../types.js';
import { computeCostUSD, computeSavedCostUSD } from '../types.js';
import type { RunStatus, InternalRunnerEvent } from '../runners/types.js';
import { createProvider } from '../provider.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { HeartbeatTimer } from '../heartbeat.js';
import { runSpecReview } from '../review/spec-reviewer.js';
import { runQualityReview } from '../review/quality-reviewer.js';
import type { QualityReviewResult } from '../review/quality-reviewer.js';
import { aggregateResult } from '../review/aggregate-result.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { autoCommitFiles } from '../auto-commit.js';
import { partitionFilePaths, checkOutputTargets } from '../file-artifact-check.js';
import type { RunTasksProgressCallback } from './index.js';
import { extractWorkerStatus } from './worker-status.js';
import { buildFallbackImplReport, readImplementerFileContents } from './fallback-report.js';
import { withDoneCondition } from './execute-task.js';

export async function executeReviewedLifecycle(
  task: TaskSpec,
  resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean },
  config: MultiModelConfig,
  taskIndex: number,
  onProgress?: RunTasksProgressCallback,
  heartbeatWiring?: { batchId?: string; recordHeartbeat?: (tick: import('../heartbeat.js').HeartbeatTickInfo) => void },
  diagnostics?: {
    logger?: import('../diagnostics/disconnect-log.js').DiagnosticLogger;
    verbose?: boolean;
    verboseStream?: (line: string) => void;
  },
): Promise<RunResult> {
  const reviewPolicy = task.reviewPolicy ?? 'full';
  const otherSlot: AgentType = resolved.slot === 'standard' ? 'complex' : 'standard';

  // Partition filePaths into output targets before the worker runs.
  // Output targets are paths that do not yet exist on disk.
  const { outputTargets } = partitionFilePaths(task.filePaths, task.cwd ?? process.cwd());

  let escalationProvider: Provider | undefined;
  try {
    escalationProvider = createProvider(otherSlot, config);
  } catch {
    // Other slot not configured — auto-escalation not available
  }

  const stageCount =
    reviewPolicy === 'off' ? 1 :
    reviewPolicy === 'spec_only' ? 3 :
    5;
  const verbose = diagnostics?.verbose ?? false;
  let lastStageSeen: string | undefined;
  const verboseStreamRaw = verbose
    ? (diagnostics?.verboseStream ?? ((line: string) => { process.stderr.write(line + '\n'); }))
    : undefined;
  const verboseBatchIdEarly = heartbeatWiring?.batchId;
  const shortBatchEarly = verboseBatchIdEarly ? verboseBatchIdEarly.slice(0, 8) : '????????';
  // Start the heartbeat whenever there's a downstream consumer:
  // - onProgress (external progress callback from the runTasks caller)
  // - verbose (stderr stream needs the heartbeat's tool_call / turn_complete relay)
  // - recordHeartbeat (server needs heartbeat ticks to update BatchRegistry)
  // - logger (post-mortem JSONL logging needs the events too)
  // Otherwise there is no point creating a timer.
  const needHeartbeat =
    onProgress !== undefined ||
    verbose ||
    heartbeatWiring?.recordHeartbeat !== undefined ||
    diagnostics?.logger !== undefined;
  // Synthesize an onProgress sink when the caller didn't pass one — the
  // heartbeat needs a place to emit heartbeat events so the stage-change
  // detector below fires. Discards events if there is no external consumer.
  const synthOnProgress: RunTasksProgressCallback = onProgress ?? (() => {});
  const heartbeat = needHeartbeat
    ? new HeartbeatTimer(
        (event) => {
          if (verboseStreamRaw && event.kind === 'heartbeat') {
            // Emit on every heartbeat tick so the operator can confirm
            // the timer is actually firing. Stage-change lines are richer
            // but fire only on transitions; plain ticks let you see
            // per-5s progress inside a long-running stage.
            if (event.stage !== lastStageSeen) {
              if (lastStageSeen !== undefined) {
                verboseStreamRaw(
                  `[mmagent verbose] batch=${shortBatchEarly} task=${taskIndex} stage ${lastStageSeen} → ${event.stage}`,
                );
              }
              lastStageSeen = event.stage;
            }
            const costStr = event.costUSD !== null ? ` cost=$${event.costUSD.toFixed(4)}` : '';
            const roundStr = event.reviewRound !== undefined && event.maxReviewRounds !== undefined
              ? ` round=${event.reviewRound}/${event.maxReviewRounds}`
              : '';
            const sinceLastMs = Date.now() - prevEventAtMs;
            verboseStreamRaw(
              `[mmagent verbose] batch=${shortBatchEarly} task=${taskIndex} heartbeat ${event.elapsed} stage=${event.stage}${roundStr} tools=${event.progress.toolCalls} read=${event.progress.filesRead} wrote=${event.progress.filesWritten} text=${textEmissionChars}c${costStr} idle=${sinceLastMs}ms`,
            );
          }
          synthOnProgress(taskIndex, event);
        },
        {
          provider: resolved.provider.config.model,
          parentModel: task.parentModel,
          ...(heartbeatWiring?.batchId !== undefined && { batchId: heartbeatWiring.batchId }),
          ...(heartbeatWiring?.recordHeartbeat !== undefined && { recordHeartbeat: heartbeatWiring.recordHeartbeat }),
        },
      )
    : undefined;
  heartbeat?.start(stageCount);
  if (verboseStreamRaw) {
    verboseStreamRaw(
      `[mmagent verbose] batch=${shortBatchEarly} task=${taskIndex} heartbeat ` +
      (heartbeat ? `started (stageCount=${stageCount}, 5s tick)` : 'DISABLED (no consumer)'),
    );
  }

  const implModel = resolved.provider.config.model;

  const progressCounters = { filesRead: 0, filesWritten: 0, toolCalls: 0 };
  const verboseLogger = verbose && diagnostics?.logger ? diagnostics.logger : undefined;
  const verboseBatchId = verboseBatchIdEarly;
  const verboseStream = verboseStreamRaw;
  const shortBatch = shortBatchEarly;
  if (verboseStream) {
    verboseStream(
      `[mmagent verbose] batch=${shortBatch} task=${taskIndex} start worker=${resolved.provider.config.model}`,
    );
  }
  let prevEventAtMs = verbose ? Date.now() : 0;
  // Wrap whenever we have ANY consumer for InternalRunnerEvent (heartbeat,
  // verbose stream, or verbose logger). Previously this only wrapped when
  // the caller passed onProgress, so --verbose + HTTP handlers (which don't
  // pass onProgress) silently dropped every tool_call / turn_complete event.
  let textEmissionChars = 0;
  const wrappedOnProgress = needHeartbeat
    ? (event: InternalRunnerEvent) => {
        if (event.kind === 'turn_start') {
          if (verbose) prevEventAtMs = Date.now();
          if (verboseStream) {
            verboseStream(
              `[mmagent verbose] batch=${shortBatch} task=${taskIndex} turn_start turn=${event.turn} provider=${event.provider}`,
            );
          }
        }
        if (event.kind === 'text_emission') {
          textEmissionChars += event.chars;
          if (verboseStream && event.chars > 0) {
            const preview = event.preview.length > 60
              ? event.preview.slice(0, 57) + '...'
              : event.preview;
            verboseStream(
              `[mmagent verbose] batch=${shortBatch} task=${taskIndex} text +${event.chars}c (total ${textEmissionChars}) preview="${preview.replace(/\n/g, '\\n')}"`,
            );
          }
        }
        if (event.kind === 'tool_call') {
          progressCounters.toolCalls++;
          const name = event.toolSummary.split('(')[0];
          if (name === 'readFile' || name === 'grep' || name === 'glob' || name === 'listFiles') {
            progressCounters.filesRead++;
          } else if (name === 'writeFile' || name === 'editFile') {
            progressCounters.filesWritten++;
          }
          heartbeat?.updateProgress(progressCounters.filesRead, progressCounters.filesWritten, progressCounters.toolCalls);
          const now = verbose ? Date.now() : 0;
          const sincePrevMs = verbose ? now - prevEventAtMs : 0;
          if (verbose) prevEventAtMs = now;
          if (verboseLogger && verboseBatchId) {
            verboseLogger.toolCall({
              batchId: verboseBatchId,
              taskIndex,
              tool: event.toolSummary,
              durationMs: sincePrevMs,
            });
          }
          if (verboseStream) {
            verboseStream(`[mmagent verbose] batch=${shortBatch} task=${taskIndex} tool=${event.toolSummary} +${sincePrevMs}ms`);
          }
        }
        if (event.kind === 'turn_complete') {
          const costUSD = computeCostUSD(
            event.cumulativeInputTokens,
            event.cumulativeOutputTokens,
            resolved.provider.config,
          );
          const savedCostUSD = computeSavedCostUSD(
            costUSD,
            event.cumulativeInputTokens,
            event.cumulativeOutputTokens,
            task.parentModel,
          );
          heartbeat?.updateCost(costUSD, savedCostUSD);
          const nowTurn = verbose ? Date.now() : 0;
          const turnDurMs = verbose ? nowTurn - prevEventAtMs : 0;
          if (verbose) prevEventAtMs = nowTurn;
          if (verboseLogger && verboseBatchId) {
            verboseLogger.llmTurn({
              batchId: verboseBatchId,
              taskIndex,
              turnIndex: progressCounters.toolCalls,
              provider: resolved.provider.config.model,
              inputTokens: event.cumulativeInputTokens,
              outputTokens: event.cumulativeOutputTokens,
              costUSD,
            });
          }
          if (verboseStream) {
            const costStr = costUSD !== null ? ` $${costUSD.toFixed(4)}` : '';
            verboseStream(
              `[mmagent verbose] batch=${shortBatch} task=${taskIndex} ` +
              `turn in=${event.cumulativeInputTokens} out=${event.cumulativeOutputTokens}${costStr} ` +
              `+${turnDurMs}ms (${resolved.provider.config.model})`,
            );
          }
        }
      }
    : undefined;

  // Track auto-commit state across all rounds
  let commitSha: string | undefined;
  let commitError: string | undefined;

  try {
    const implResult = await delegateWithEscalation(
      withDoneCondition(task),
      [resolved.provider],
      { explicitlyPinned: false, escalateToProvider: escalationProvider, onProgress: wrappedOnProgress },
    );

    const implReport = implResult.status === 'ok' ? parseStructuredReport(implResult.output) : undefined;
    const workerStatus = extractWorkerStatus(implReport);

    // Auto-commit: commit the worker's file changes
    if (task.autoCommit && implResult.status === 'ok' && implResult.filesWritten.length > 0) {
      const commitResult = autoCommitFiles(
        implResult.filesWritten,
        implReport?.summary ?? undefined,
        task.cwd ?? process.cwd(),
      );
      commitSha = commitResult.sha;
      commitError = commitResult.error;
    }

    const filePathsInteracted = task.filePaths && task.filePaths.length > 0
      ? [...(implResult.filesRead ?? []), ...implResult.filesWritten].some(f =>
          task.filePaths!.some(fp => f === fp || f.endsWith('/' + fp) || f.endsWith(fp)),
        )
      : true;
    const filePathsSkipped = !filePathsInteracted;

    if (implResult.filesWritten.length === 0) {
      heartbeat?.updateStageCount(1);
      const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);
      const earlyFileArtifactsMissing = implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined;
      const earlyStatus: RunStatus =
        implResult.status === 'ok' && earlyFileArtifactsMissing
          ? 'incomplete'
          : implResult.status;
      return {
        ...implResult,
        status: earlyStatus,
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
        fileArtifactsMissing: earlyFileArtifactsMissing,
        commitSha,
        commitError,
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
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        commitSha,
        commitError,
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
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        commitSha,
        commitError,
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
        fileArtifactsMissing: implResult.status === 'ok' ? checkOutputTargets(outputTargets) : undefined,
        commitSha,
        commitError,
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

    heartbeat?.transition({
      stage: 'spec_review', stageIndex: 2,
      reviewRound: 1, maxReviewRounds: task.maxReviewRounds ?? 5,
    });

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
        heartbeat?.transition({
          stage: 'spec_rework', stageIndex: 3,
          reviewRound: round, maxReviewRounds: task.maxReviewRounds ?? 5,
        });
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

        // Auto-commit rework changes
        if (task.autoCommit && reworkResult.status === 'ok' && reworkResult.filesWritten.length > 0) {
          const reworkReport = parseStructuredReport(reworkResult.output);
          const reworkCommit = autoCommitFiles(
            reworkResult.filesWritten,
            reworkReport.summary ?? undefined,
            task.cwd ?? process.cwd(),
          );
          if (reworkCommit.sha) commitSha = reworkCommit.sha;
          if (reworkCommit.error) commitError = reworkCommit.error;
        }

        finalImplResult = reworkResult;
        const reworkReport = parseStructuredReport(reworkResult.output);
        finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

        const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);
        fileContents = reworkContents;

        heartbeat?.transition({
          stage: 'spec_review', stageIndex: 2,
          reviewRound: round + 1, maxReviewRounds: task.maxReviewRounds ?? 5,
        });
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

        const currentFindings = [...specResult.findings].sort().join('\0');
        const prevFindings = prevSpecFindings.sort().join('\0');
        if (currentFindings === prevFindings && currentFindings !== '') break;

        prevSpecFindings = specResult.findings;

        if (round >= (task.maxReviewRounds ?? 5)) break;
      }
    }

    let qualityResult: QualityReviewResult = { status: 'skipped', report: undefined, findings: [] };
    if (reviewPolicy === 'full') {
      heartbeat?.transition({
        stage: 'quality_review', stageIndex: 4,
        reviewRound: 1, maxReviewRounds: task.maxReviewRounds ?? 5,
      });
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
          heartbeat?.transition({
            stage: 'quality_rework', stageIndex: 5,
            reviewRound: round, maxReviewRounds: task.maxReviewRounds ?? 5,
          });
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

          // Auto-commit rework changes
          if (task.autoCommit && reworkResult.status === 'ok' && reworkResult.filesWritten.length > 0) {
            const reworkReport = parseStructuredReport(reworkResult.output);
            const reworkCommit = autoCommitFiles(
              reworkResult.filesWritten,
              reworkReport.summary ?? undefined,
              task.cwd ?? process.cwd(),
            );
            if (reworkCommit.sha) commitSha = reworkCommit.sha;
            if (reworkCommit.error) commitError = reworkCommit.error;
          }

          finalImplResult = reworkResult;
          const reworkReport = parseStructuredReport(reworkResult.output);
          finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

          const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);

          heartbeat?.transition({
            stage: 'quality_review', stageIndex: 4,
            reviewRound: round + 1, maxReviewRounds: task.maxReviewRounds ?? 5,
          });
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

          if (round >= (task.maxReviewRounds ?? 5)) break;
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

    // File artifact verification: check whether output targets exist on disk after all work.
    // Only applies when status is ok; non-ok statuses skip verification entirely.
    const fileArtifactsMissing =
      finalImplResult.status === 'ok' && outputTargets.length > 0
        ? checkOutputTargets(outputTargets)
        : undefined;

    // Status downgrade: review verdicts are authoritative. File artifact verification
    // is also authoritative — missing output targets downgrade ok → incomplete.
    const finalStatus: RunStatus =
      finalImplResult.status === 'ok' &&
      (specStatus === 'changes_required' || qualityResult.status === 'changes_required')
        ? 'incomplete'
        : finalImplResult.status === 'ok' && fileArtifactsMissing
          ? 'incomplete'
          : finalImplResult.status;

    return {
      ...finalImplResult,
      status: finalStatus,
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
      fileArtifactsMissing,
      commitSha,
      commitError,
    };
  } finally {
    heartbeat?.stop();
  }
}
