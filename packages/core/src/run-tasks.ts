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
import { expandContextBlocks } from './context/expand-context-blocks.js';
import { inferEffort } from './effort-inference.js';
import { evaluateReadiness } from './readiness/readiness.js';
import { normalizeBrief } from './readiness/normalize-brief.js';
import { runSpecReview } from './review/spec-reviewer.js';
import { runQualityReview } from './review/quality-reviewer.js';
import { aggregateResult } from './review/aggregate-result.js';
import type { ParsedStructuredReport } from './reporting/structured-report.js';
import { parseStructuredReport } from './reporting/structured-report.js';
import type { NormalizationResult } from './readiness/normalize-brief.js';
import fs from 'fs/promises';

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

async function executeTask(
  resolved: Exclude<ResolvedTask, { error: string }>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  try {
    return await delegateWithEscalation(
      resolved.task,
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
    normalizationDecisions: [],
    validationsRun: [],
    deviationsFromBrief: [],
    unresolved: [],
  };
}

async function executeReviewedLifecycle(
  task: TaskSpec,
  resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean },
  config: MultiModelConfig,
  normResult: NormalizationResult | undefined,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunResult> {
  const reviewPolicy = task.reviewPolicy ?? 'full';
  const maxRounds = task.maxReviewRounds ?? 2;
  const otherSlot: AgentType = resolved.slot === 'standard' ? 'complex' : 'standard';

  const implResult = await delegateWithEscalation(
    task,
    [resolved.provider],
    { explicitlyPinned: true, onProgress },
  );

  const implReport = implResult.status === 'ok' ? parseStructuredReport(implResult.output) : undefined;
  const workerStatus = extractWorkerStatus(implReport);

  // C6a: Skip review when there are no file artifacts to review
  const hasWorkProduct = implResult.filesWritten.length > 0;
  if (!hasWorkProduct) {
    return {
      ...implResult,
      workerStatus,
      specReviewStatus: 'skipped',
      qualityReviewStatus: 'skipped',
      agents: {
        normalizer: normResult && !normResult.skipped ? resolved.slot : 'skipped',
        implementer: resolved.slot,
        specReviewer: 'skipped',
        qualityReviewer: 'skipped',
      },
      implementationReport: implReport,
    };
  }

  if (workerStatus === 'needs_context' || workerStatus === 'blocked') {
    return {
      ...implResult,
      workerStatus,
      specReviewStatus: 'skipped',
      qualityReviewStatus: 'skipped',
      agents: {
        normalizer: normResult && !normResult.skipped ? resolved.slot : 'skipped',
        implementer: resolved.slot,
        specReviewer: 'skipped',
        qualityReviewer: 'skipped',
      },
    };
  }

  if (reviewPolicy === 'off') {
    return {
      ...implResult,
      workerStatus,
      specReviewStatus: 'skipped',
      qualityReviewStatus: 'skipped',
      agents: {
        normalizer: normResult && !normResult.skipped ? resolved.slot : 'skipped',
        implementer: resolved.slot,
        specReviewer: 'skipped',
        qualityReviewer: 'skipped',
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
      agents: {
        normalizer: normResult && !normResult.skipped ? resolved.slot : 'skipped',
        implementer: resolved.slot,
        specReviewer: 'skipped',
        qualityReviewer: 'skipped',
      },
    };
  }

  const packet = {
    normalizedPrompt: normResult?.normalizedPrompt ?? task.prompt,
    scope: normResult?.writeSet ?? [],
    doneCondition: 'tsc passes',
  };

  let fileContents = await readImplementerFileContents(implResult.filesWritten, task.cwd);

  const effectiveImplReport = implReport ?? buildFallbackImplReport(implResult);

  let specResult = await runSpecReview(
    otherProvider,
    packet,
    effectiveImplReport,
    fileContents,
    implResult.toolCalls,
  );

  let finalImplResult = implResult;
  let finalImplReport = effectiveImplReport;
  let specStatus = specResult.status;
  let specReport = specResult.report;

  if (specStatus === 'changes_required' && maxRounds > 0) {
    for (let round = 0; round < maxRounds; round++) {
      const reworkPrompt = `${task.prompt}\n\n## Spec Review Feedback (round ${round + 1}):\n${specResult.findings.map(f => `- ${f}`).join('\n')}`;

      const reworkResult = await delegateWithEscalation(
        { ...task, prompt: reworkPrompt },
        [resolved.provider],
        { explicitlyPinned: true, onProgress },
      );

      finalImplResult = reworkResult;
      const reworkReport = parseStructuredReport(reworkResult.output);
      finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

      const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);
      fileContents = reworkContents;

      specResult = await runSpecReview(
        otherProvider,
        packet,
        finalImplReport,
        reworkContents,
        reworkResult.toolCalls,
      );

      specStatus = specResult.status;
      specReport = specResult.report;

      if (specStatus === 'approved') break;
    }
  }

  let qualityResult: { status: 'approved' | 'changes_required' | 'skipped' | 'error'; report?: import('./reporting/structured-report.js').ParsedStructuredReport; findings: string[] } = { status: 'skipped', report: undefined, findings: [] };
  if (reviewPolicy === 'full') {
    qualityResult = await runQualityReview(
      otherProvider,
      packet,
      specReport ?? finalImplReport,
      fileContents,
      finalImplResult.toolCalls,
      finalImplResult.filesWritten,
    );

    if (qualityResult.status === 'changes_required' && maxRounds > 0) {
      for (let round = 0; round < maxRounds; round++) {
        const reworkPrompt = `${task.prompt}\n\n## Quality Review Feedback (round ${round + 1}):\n${qualityResult.findings.map(f => `- ${f}`).join('\n')}`;

        const reworkResult = await delegateWithEscalation(
          { ...task, prompt: reworkPrompt },
          [resolved.provider],
          { explicitlyPinned: true, onProgress },
        );

        finalImplResult = reworkResult;
        const reworkReport = parseStructuredReport(reworkResult.output);
        finalImplReport = reworkReport.summary ? reworkReport : buildFallbackImplReport(reworkResult);

        const reworkContents = await readImplementerFileContents(reworkResult.filesWritten, task.cwd);

        qualityResult = await runQualityReview(
          otherProvider,
          packet,
          finalImplReport,
          reworkContents,
          reworkResult.toolCalls,
          reworkResult.filesWritten,
        );

        if (qualityResult.status === 'approved') break;
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
    structuredReport: aggregated,
    implementationReport: finalImplReport,
    specReviewReport: specReport,
    qualityReviewReport: qualityResult.report,
    agents: {
      normalizer: normResult && !normResult.skipped ? resolved.slot : 'skipped',
      implementer: resolved.slot,
      specReviewer: otherSlot,
      qualityReviewer: reviewPolicy === 'full' ? otherSlot : 'skipped',
    },
  };
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

  const normalizationResults = await Promise.all(
    expandedTasks.map(async (entry, idx) => {
      if ('error' in entry) return undefined;
      const readiness = readinessResults[idx];
      if (!readiness || readiness.action !== 'normalize') return undefined;
      return await normalizeBrief(entry as TaskSpec, config);
    }),
  );

  const effectiveTasks: (TaskSpec | { error: string })[] = expandedTasks.map((entry, idx) => {
    if ('error' in entry) return entry;
    const norm = normalizationResults[idx];
    if (norm && !norm.skipped) {
      return { ...(entry as TaskSpec), prompt: norm.normalizedPrompt };
    }
    return entry;
  });

  const resolved: ResolvedTask[] = effectiveTasks.map((entry, idx): ResolvedTask => {
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
      const normResult = normalizationResults[index];
      const taskProgress = options.onProgress
        ? (event: ProgressEvent) => options.onProgress!(index, event)
        : undefined;

      const readiness = readinessResults[index];
      return executeReviewedLifecycle(r.task, r.resolved, config, normResult, taskProgress).then(
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
