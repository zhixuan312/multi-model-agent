import { randomUUID } from 'node:crypto';
import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import {
  taskInputSchema,
  getTypeConfig,
  oppositeAgent,
  loadSkill,
  resolveAgent,
  runTwoPhasePipeline,
  parsePlanHeadings,
  matchTasks,
  MatchError,
} from '@zhixuan92/multi-model-agent-core';
import { resolveRateCard, priceTokens } from '@zhixuan92/multi-model-agent-core/bounded-execution/cost-compute';
import type { PipelineResult, AgentType, TaskType } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelope, StageRecord, Route } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
import type { Provider } from '@zhixuan92/multi-model-agent-core';
import type { ResearchConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import {
  BraveClient,
  runOrchestrator,
  parseQueryPlan,
  serializeEvidencePack,
  summarizeSourcesUsed,
  resolveEnabledAdapters,
  arxivSearch,
  semanticScholarSearch,
  githubSearch,
  openalexSearch,
  crossrefSearch,
  pubmedSearch,
} from '@zhixuan92/multi-model-agent-core/research';
import type { EvidencePack, SourceUsage, BraveSearchOptions } from '@zhixuan92/multi-model-agent-core/research';
import { sendJson, sendError } from '../errors.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return true;
  } catch { return false; }
}

function tryParseJson(raw: string): unknown {
  const fenced = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  const match = fenced.length ? fenced[fenced.length - 1] : raw.match(/(\{[\s\S]*\})/);
  if (!match) return raw;
  try { return JSON.parse(match[1]); } catch { return raw; }
}

/** Map unified TaskType (underscores) to wire Route (hyphens). */
function taskTypeToRoute(type: TaskType): Route {
  const map: Record<string, Route> = {
    execute_plan: 'execute-plan',
    journal_recall: 'journal-recall',
    journal_record: 'journal-record',
    retry_tasks: 'retry',
  };
  return (map[type] ?? type) as Route;
}

/**
 * Build a goal condition string for the Stop hook. This keeps the agent
 * working until it has covered all criteria defined in the skill file.
 */
function buildGoalCondition(type: TaskType, role: 'implementer' | 'reviewer', skillContent: string): string | undefined {
  if (role === 'reviewer') {
    return [
      'You have verified every criterion the implementer was supposed to cover.',
      'You have checked for hallucinated findings (claims without evidence in the source material).',
      'You have validated evidence quality (every finding cites actual file:line or quoted text).',
      'You have checked weight calibration against the skill definitions.',
      'You have verified the implementer\'s draft and output the refined answer in the same JSON format as the implementer.',
      'No findings, verdict, or meta-commentary -- only the final answer in a ```json fenced block.',
    ].join(' ');
  }

  switch (type) {
    case 'audit': {
      const countMatch = skillContent.match(/(\d+)\s+(?:Verification Criteria|perspectives|failure modes|Execution Steps)/i);
      const count = countMatch ? countMatch[1] : 'all';
      return [
        `You have evaluated the document against ALL ${count} criteria one by one.`,
        'For each criterion, you wrote findings to the scratch file before moving to the next.',
        'Every criterion either has findings with quoted evidence, or an explicit "No findings for this criterion." entry.',
        'You have read the scratch file and consolidated into the final JSON output block.',
        `The criteriaCovered array in your output lists all ${count} criteria.`,
      ].join(' ');
    }
    case 'investigate':
      return [
        'You have applied ALL 5 investigation perspectives: direct-symbol-trace, caller-analysis, test-driven, cross-file dependency-map, documentation/comment-lens.',
        'Every finding cites file:line from files you actually read (no training-data citations).',
        'Absent things are evidenced with "searched <pattern> in <path>, no matches."',
        'You have calibrated weight (critical/high/medium/low) based on evidence strength.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'review':
      return [
        'You have swept ALL 10 review categories: test gap, cross-file ripple, pre-existing-vs-regression, missing edge case, race/concurrency, resource leak, backward-compat break, security regression, performance regression, implicit-contract assumption.',
        'Cross-file findings cite both the change site AND the broken caller.',
        'Pre-existing bugs are separated from new regressions.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'debug':
      return [
        'You have applied ALL 4 investigation angles: symptom-location, recent-change, test-failure, reproduction.',
        'Your trace chain has at least 3 evidence points: symptom → intermediate state → cause, each with file:line.',
        'You have proposed a fix (read-only — describe, do not apply).',
        'You have stated a falsifier (how the maintainer verifies the fix).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'research':
      return [
        'You have searched from ALL 5 perspectives: primary-sources, practitioner-consensus, recent-developments, counter-perspectives, cross-domain.',
        'Every finding cites a real source with URL or identifier.',
        'Source tier (primary/practitioner/recent) is indicated.',
        'You have produced the required JSON output block with sources, findings, and synthesis.',
      ].join(' ');
    case 'delegate':
      return [
        'You have implemented ALL requested changes in the task description.',
        'Only the declared target paths were modified (no scope creep).',
        'If tests exist for the changed area, you have verified they pass.',
        'You have produced the required JSON output block listing tasks completed and files changed.',
      ].join(' ');
    case 'execute_plan':
      return [
        'You have followed EVERY step in the plan exactly as written.',
        'Code blocks in the plan were applied verbatim (no substitution or improvisation).',
        'If the plan lists verification commands, you ran them.',
        'No steps were skipped or reordered.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'journal_record':
      return [
        'You have classified the entry by type (decision/design/behavior/process/knowledge/style) and operation (create/refine/supersede/merge).',
        'You have checked the existing journal for supersede/refine/merge candidates.',
        'You have written the node file with proper YAML frontmatter (including type) and edges.',
        'You have updated the journal catalog (log.md and index.md with type column).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'journal_recall':
      return [
        'You have searched from ALL 3 perspectives: keyword-match, graph-neighborhood, contradiction-and-history.',
        'Superseded nodes are excluded from results.',
        'Each result includes the learning, context, and relevance assessment.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'spec':
      return [
        'You have read the structured design decisions from the input.',
        'You have written a complete spec file with YAML frontmatter and ALL required sections: Context, Problem, Goals & Requirements, Scope, Constraints, Success Metrics, Alternatives, Decision Records, Technical Design, Testing Plan, Acceptance Criteria.',
        'Every functional requirement uses must/should/may language and maps to an acceptance criterion.',
        'No placeholder language exists (no TBD, TODO, or vague verbs).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'plan':
      return [
        'You have read the spec and explored the codebase to discover ground truth at HEAD.',
        'You have written a complete plan file with Goal/Architecture/Tech Stack header, File Structure section, and Track-organized TDD tasks.',
        'Every task has the exact structure: failing test → verify fail → minimal code → verify pass.',
        'Every code block is complete — no placeholders, no "similar to Task N".',
        'Every file path was verified against the codebase.',
        'Every verification command uses the project actual test runner.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'orchestrate':
      return [
        'You have fully processed the prompt and produced the requested output.',
        'If an output format was specified, your response conforms to that format.',
        'Your response is the deliverable — no meta-commentary wrapping it.',
      ].join(' ');
    default:
      return 'You have completed the task as specified in the skill instructions and produced the required output.';
  }
}

/**
 * Build a minimal TaskEnvelope-compatible snapshot from a PipelineResult
 * so the TelemetryUploader can convert it to a wire record and enqueue it.
 */
function buildEnvelopeSnapshot(
  taskId: string,
  type: TaskType,
  result: PipelineResult,
  implTier: AgentType,
  revTier: AgentType,
  reviewPolicy: 'reviewed' | 'none',
  implModel: string,
  revModel: string,
  mainModel: string,
  cwd: string,
  durationMs: number,
  sourcesUsed: TaskEnvelope['sourcesUsed'] = [],
): TaskEnvelope {
  const now = new Date().toISOString();
  const route = taskTypeToRoute(type);

  // Build stage records from the pipeline turns.
  const stages: StageRecord[] = [];
  const implTurn = result.implementerTurn;
  stages.push({
    name: 'implementing',
    round: 1,
    outcome: result.status === 'failed' ? 'fail' : 'advance',
    startedAt: now,
    completedAt: now,
    durationMs: implTurn.durationMs,
    costUSD: implTurn.costUSD,
    model: implModel,
    tier: implTier,
    turnsUsed: implTurn.turns,
    filesWrittenCount: implTurn.filesWritten.length,
    inputTokens: implTurn.usage.inputTokens,
    outputTokens: implTurn.usage.outputTokens,
    cachedReadTokens: implTurn.usage.cachedReadTokens,
    cachedNonReadTokens: implTurn.usage.cachedNonReadTokens,
  });

  if (result.reviewerTurn) {
    const revTurn = result.reviewerTurn;
    stages.push({
      name: 'reviewing',
      round: 1,
      outcome: result.status === 'done_with_concerns' ? 'concern' : 'advance',
      startedAt: now,
      completedAt: now,
      durationMs: revTurn.durationMs,
      costUSD: revTurn.costUSD,
      model: revModel,
      tier: revTier,
      turnsUsed: revTurn.turns,
      filesWrittenCount: 0,
      inputTokens: revTurn.usage.inputTokens,
      outputTokens: revTurn.usage.outputTokens,
      cachedReadTokens: revTurn.usage.cachedReadTokens,
      cachedNonReadTokens: revTurn.usage.cachedNonReadTokens,
      verdict: result.status === 'done_with_concerns' ? 'concerns' : 'approved',
      concernCategories: [],
    });
  }

  const totalInputTokens = stages.reduce((s, st) => s + st.inputTokens, 0);
  const totalOutputTokens = stages.reduce((s, st) => s + st.outputTokens, 0);
  const totalCachedRead = stages.reduce((s, st) => s + (st.cachedReadTokens ?? 0), 0);
  const totalCachedNonRead = stages.reduce((s, st) => s + (st.cachedNonReadTokens ?? 0), 0);
  const totalCostUSD = stages.reduce((s, st) => s + (st.costUSD ?? 0), 0);

  return {
    taskId,
    batchId: taskId,
    taskIndex: 0,
    route,
    agentType: implTier,
    client: 'claude-code',
    mainModel,
    cwd,
    startedAt: now,
    status: result.status,
    terminalAt: now,
    stopReason: null,
    structuredError: result.status === 'failed'
      ? { code: 'pipeline_failed', message: 'Pipeline completed with failed status' }
      : null,
    errorCode: null,
    reviewPolicy: reviewPolicy === 'none' ? 'none' : 'reviewed',
    plannedStageTotal: stages.length,
    stages,
    toolCalls: [],
    filesWritten: implTurn.filesWritten,
    realFilesChanged: implTurn.filesWritten,
    commitSha: null,
    commitMessage: null,
    commitSkipReason: null,
    contextBlockId: null,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCachedReadTokens: totalCachedRead,
    totalCachedNonReadTokens: totalCachedNonRead,
    totalDurationMs: durationMs,
    turnsUsed: stages.reduce((s, st) => s + st.turnsUsed, 0),
    stallCount: 0,
    sandboxViolationCount: 0,
    taskMaxIdleMs: 0,
    findings: [],
    sourcesUsed,
    escalationLog: [],
    validationWarnings: [],
    headline: { prefix: '', stageLabel: 'done', stageIndex: stages.length, stageTotal: stages.length, toolWrites: 0, toolTotal: 0 },
  };
}

// ─── Research pre-processing ─────────────────────────────────────────────

interface ResearchContext {
  /** Serialized evidence pack to inject into the implementer prompt. */
  evidenceMarkdown: string;
  /** Structured source-usage summary for the response envelope. */
  sourcesUsed: SourceUsage[];
}

const QUERY_PLAN_PROMPT = `You are a research query planner. Given a research question and background, emit ONLY a JSON query plan — no prose, no code fences.

The JSON must conform to this shape:
{
  "braveQueries": [{"q": "<query>", "freshness": "pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD", "endpoint": "web|news", "siteFilter": "site:domain.com"}, ...],
  "arxivQueries":           ["<search query string>", ...],
  "semanticScholarQueries": ["<search query string>", ...],
  "githubQueries":          [{"q": "<search query string>", "kind": "repo|code"}, ...],
  "openalexQueries":        ["<search query string>", ...],
  "crossrefQueries":        ["<search query string>", ...],
  "pubmedQueries":          ["<search query string>", ...]
}

Rules:
- Max 8 entries per array, max 200 chars per query string.
- Phrase queries as topical keywords, NOT full sentences.
- Empty arrays are allowed for sources you do not need.
- braveQueries: freshness, endpoint, siteFilter are all optional. Omit for default web search.
  Use freshness for recent/current data. Use endpoint:"news" for financial/news topics.
  Use siteFilter to restrict to known authoritative domains (e.g., "site:sec.gov").
- openalexQueries: broadest academic coverage (250M+ works, all disciplines).
- crossrefQueries: DOI-registered publications, authoritative metadata.
- pubmedQueries: biomedical/life-sciences focus, use MeSH terms when appropriate.
- Emit ONLY the JSON object.`;

/**
 * Turn 1 + orchestrator: ask the implementer LLM for a QueryPlan, then fan
 * out across real adapters to gather an EvidencePack. Falls back gracefully:
 * - If the LLM output isn't parseable as a QueryPlan, returns null (caller
 *   proceeds with LLM-only research).
 * - If the orchestrator throws, returns null.
 */
async function prepareResearchContext(
  researchQuestion: string,
  background: string,
  implProvider: Provider,
  researchCfg: ResearchConfig,
  taskId: string,
  cwd: string,
): Promise<ResearchContext | null> {
  // --- Turn 1: generate a query plan via the implementer LLM ---
  const planSession = implProvider.openSession({
    cwd,
    wallClockDeadline: Date.now() + 60_000,  // 60s budget for plan generation
    abortSignal: new AbortController().signal,
    taskId,
    taskIndex: 0,
  });

  try {
    const planPrompt = [
      QUERY_PLAN_PROMPT,
      '',
      '## Research Question',
      researchQuestion,
      '',
      '## Background',
      background,
    ].join('\n');

    const planTurn = await planSession.send(planPrompt);
    const planOutput = planTurn.output.trim();

    // Extract JSON from the output — the LLM may wrap it in code fences
    let jsonStr = planOutput;
    const fenceMatch = planOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    const queryPlan = parseQueryPlan(jsonStr);

    // --- Orchestrator: fan out queries against real APIs ---
    const enabledAdapters = resolveEnabledAdapters(researchCfg.builtinAdapters, {
      semanticScholarApiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
      githubPat: researchCfg.builtinAdapters.githubPat,
    });

    // Build BraveClient only if API keys are configured
    const hasBraveKeys = researchCfg.brave.apiKeys.length > 0;
    const braveClient = hasBraveKeys ? new BraveClient(researchCfg.brave) : null;

    const pack = await runOrchestrator(queryPlan, {
      enabledAdapters,
      brave: {
        search: async (query: string, options?: BraveSearchOptions) => {
          if (!braveClient) {
            throw new Error('brave_not_configured: no API keys');
          }
          return braveClient.search(query, options);
        },
      },
      adapters: {
        arxiv: (q) => arxivSearch(q),
        semanticScholar: (q) => semanticScholarSearch(q, {
          apiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
        }),
        github: (q, kind) => githubSearch(q, {
          kind,
          pat: researchCfg.builtinAdapters.githubPat,
        }),
        openalex: (q) => openalexSearch(q, {
          contactEmail: researchCfg.builtinAdapters.contactEmail,
        }),
        crossref: (q) => crossrefSearch(q, {
          contactEmail: researchCfg.builtinAdapters.contactEmail,
        }),
        pubmed: (q) => pubmedSearch(q, {
          apiKey: researchCfg.builtinAdapters.pubmedApiKey,
        }),
      },
      perAdapterTimeoutMs: researchCfg.brave.timeoutMs,
      totalDeadlineMs:     30_000,
      concurrencyCap:      4,
    });

    const evidenceMarkdown = serializeEvidencePack(pack);
    const sourcesUsed = summarizeSourcesUsed(pack);

    process.stderr.write(
      `[mma] event=research_evidence_ready ts=${new Date().toISOString()} task=${taskId} sources=${pack.sources.length} failed=${pack.failedAttempts.length}\n`,
    );

    return { evidenceMarkdown, sourcesUsed };
  } catch (err) {
    process.stderr.write(
      `[mma] event=research_preprocess_failed ts=${new Date().toISOString()} task=${taskId} error="${((err instanceof Error ? err.message : String(err))).replace(/"/g, '\\"')}"\n`,
    );
    return null;
  } finally {
    try { await planSession.close(); } catch { /* best-effort */ }
  }
}

// ─── Handler helpers ─────────────────────────────────────────────────────

const thisDir = path.dirname(fileURLToPath(import.meta.url));

function resolveSkillsDir(): string {
  // Dev (monorepo): packages/server/src/http/handlers/ → packages/core/src/skills/
  const devPath = path.resolve(thisDir, '..', '..', '..', '..', '..', 'packages', 'core', 'src', 'skills');
  if (fs.existsSync(devPath)) return devPath;
  // Production (global install): server package root → node_modules/@zhixuan92/multi-model-agent-core/src/skills/
  const serverRoot = path.resolve(thisDir, '..', '..', '..');
  const prodPath = path.join(serverRoot, 'node_modules', '@zhixuan92', 'multi-model-agent-core', 'src', 'skills');
  if (fs.existsSync(prodPath)) return prodPath;
  return devPath;
}
const SKILLS_DIR = resolveSkillsDir();

export function buildUnifiedTaskHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, _params, ctx) => {
    const parsed = taskInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const cwd = ctx.cwd;
    if (!cwd) {
      sendError(res, 400, 'invalid_cwd', 'cwd query parameter required');
      return;
    }

    const typeConfig = getTypeConfig(input.type);
    const implTier = (input as Record<string, unknown>).agentTier as AgentType | undefined ?? typeConfig.defaultTier;
    const revTier = oppositeAgent(implTier);
    const reviewPolicy = input.type === 'orchestrate' ? 'none' : (input.reviewPolicy ?? 'reviewed');

    let implAgent, revAgent;
    try {
      implAgent = resolveAgent(implTier, deps.config);
      revAgent = resolveAgent(revTier, deps.config);
    } catch (err) {
      sendError(res, 503, 'agent_not_configured', err instanceof Error ? err.message : 'Agent resolution failed');
      return;
    }

    let skills;
    try {
      const subtype = (input as Record<string, unknown>).subtype as string | undefined;
      skills = await loadSkill(input.type, SKILLS_DIR, subtype);
    } catch (err) {
      sendError(res, 500, 'skill_load_failed', err instanceof Error ? err.message : 'Skill load failed');
      return;
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const blockIds = input.contextBlockIds ?? [];
    const contextBlockStore = pc.contextBlocks;
    const sessionIds = (input as Record<string, unknown>).sessionIds as { implementer?: string; reviewer?: string } | undefined;
    const { type: _type, agentTier: _tier, reviewPolicy: _review, sessionIds: _sessions, contextBlockIds: _blocks, ...payload } = input as Record<string, unknown>;

    // Register task in TaskRegistry and return 202 immediately
    const taskId = randomUUID();
    deps.taskRegistry.register(taskId, cwd, input.type);

    // Emit task-created diagnostic for observability.
    deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_created', fields: { batch_id: taskId, route: input.type } });

    const statusUrl = `/task/${taskId}`;
    sendJson(res, 202, { taskId, statusUrl });

    // Run the pipeline asynchronously via setImmediate
    const startedAtMs = Date.now();
    setImmediate(() => {
      void (async () => {
        try {
          process.stderr.write(
            `[mma] event=executor_started ts=${new Date().toISOString()} task=${taskId} route=${input.type}\n`,
          );
          const implementerGoal = buildGoalCondition(input.type, 'implementer', skills.implement);
          const reviewerGoal = buildGoalCondition(input.type, 'reviewer', skills.review);

          // ── Execute-plan pre-processing: parse plan + smart match ──
          let dispatchedTasks: string[] | undefined;
          let copyToWorktree: string[] | undefined;
          if (input.type === 'execute_plan') {
            const epPayload = payload as { target: { paths: string[] }; tasks: string[] };
            const planPath = epPayload.target.paths[0];
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.resolve(cwd, planPath);
            let planContent: string;
            try {
              planContent = fs.readFileSync(resolvedPlanPath, 'utf-8');
            } catch {
              deps.taskRegistry.fail(taskId, { code: 'plan_not_found', message: `Plan file not found: ${planPath}` });
              return;
            }
            const headings = parsePlanHeadings(planContent);
            let matched;
            try {
              matched = matchTasks(headings, epPayload.tasks);
            } catch (err) {
              if (err instanceof MatchError) {
                deps.taskRegistry.fail(taskId, { code: err.code, message: err.message, ...(err.matches && { matches: err.matches }) });
                return;
              }
              throw err;
            }
            dispatchedTasks = matched.map(h => h.normalized);
            copyToWorktree = [path.isAbsolute(planPath) ? path.relative(fs.realpathSync(cwd), fs.realpathSync(resolvedPlanPath)) : planPath];
            const entry = deps.taskRegistry.get(taskId);
            if (entry) entry.totalTasks = matched.length;
          }

          // ── Spec/Plan pre-processing: outputPath derivation + copyToWorktree ──
          if (input.type === 'spec' || input.type === 'plan') {
            const spPayload = payload as { prompt: string; target?: { paths?: string[]; inline?: string }; outputPath?: string };
            const hasInline = spPayload.target?.inline !== undefined;
            const hasPaths = spPayload.target?.paths !== undefined && spPayload.target.paths.length > 0;

            // Validate outputPath if provided
            if (spPayload.outputPath) {
              if (spPayload.outputPath.includes('..') || path.isAbsolute(spPayload.outputPath)) {
                deps.taskRegistry.fail(taskId, { code: 'invalid_output_path', message: `outputPath must be relative to cwd and must not contain '..': ${spPayload.outputPath}` });
                return;
              }
            }

            // For plan + inline, outputPath is required
            if (input.type === 'plan' && hasInline && !spPayload.outputPath) {
              deps.taskRegistry.fail(taskId, { code: 'invalid_request', message: 'outputPath is required when type=plan uses target.inline (cannot derive basename from inline content)' });
              return;
            }

            // Derive outputPath if not provided
            if (!spPayload.outputPath) {
              const today = new Date().toISOString().slice(0, 10);
              if (input.type === 'spec') {
                const slug = spPayload.prompt.split(/[.!?\n]/)[0].trim().toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
                (payload as Record<string, unknown>).outputPath = `docs/mma/specs/${today}-${slug || 'spec'}.md`;
              } else if (hasPaths) {
                const specBase = path.basename(spPayload.target!.paths![0], path.extname(spPayload.target!.paths![0]));
                const hasDatePrefix = /^\d{4}-\d{2}-\d{2}-/.test(specBase);
                (payload as Record<string, unknown>).outputPath = hasDatePrefix
                  ? `docs/mma/plans/${specBase}.md`
                  : `docs/mma/plans/${today}-${specBase}.md`;
              }
            }

            // Set up copyToWorktree for target.paths
            if (hasPaths) {
              const filePath = spPayload.target!.paths![0];
              copyToWorktree = [path.isAbsolute(filePath) ? path.relative(fs.realpathSync(cwd), fs.realpathSync(path.resolve(cwd, filePath))) : filePath];
            }
          }

          // ── Research pre-processing: Turn 1 (query plan) + orchestrator ──
          let researchCtx: ResearchContext | null = null;
          let enrichedPayload = JSON.stringify(payload, null, 2);

          if (input.type === 'research') {
            const researchPayload = payload as { prompt: string };
            researchCtx = await prepareResearchContext(
              researchPayload.prompt,
              '',
              implAgent.provider,
              deps.config.research,
              taskId,
              cwd,
            );
            if (researchCtx) {
              // Inject the real evidence into the payload so the implementer
              // synthesizes from actual sources, not training-data recall.
              enrichedPayload = [
                enrichedPayload,
                '',
                '---',
                '',
                '## Pre-fetched Evidence (from real API queries)',
                '',
                researchCtx.evidenceMarkdown,
              ].join('\n');
            }
          }

          const onPhaseChange = (phase: 'implementing' | 'reviewing') => {
            deps.taskRegistry.setPhase(taskId, phase);
          };

          const result = await runTwoPhasePipeline({
            type: input.type,
            implementerSkill: skills.implement,
            reviewerSkill: skills.review,
            taskPayload: enrichedPayload,
            implementerProvider: implAgent.provider,
            reviewerProvider: revAgent.provider,
            implementerTier: implTier,
            reviewerTier: revTier,
            reviewPolicy,
            cwd,
            sandboxPolicy: typeConfig.sandbox,
            worktreeEnabled: typeConfig.worktree && await isGitRepo(cwd),
            taskId,
            implementerGoal,
            reviewerGoal,
            bus: deps.bus,
            onPhaseChange,
            ...(dispatchedTasks && { dispatchedTasks }),
            ...(copyToWorktree && { copyToWorktree }),
            ...(sessionIds?.implementer && { resumeImplementer: sessionIds.implementer }),
            ...(sessionIds?.reviewer && { resumeReviewer: sessionIds.reviewer }),
          });
          const durationMs = Date.now() - startedAtMs;

          // Auto-register a terminal context block for read-only routes
          // (investigate, audit, review, debug, research, journal_recall)
          // so callers can reference the output in subsequent dispatches.
          let contextBlockId: string | null = null;
          if (typeConfig.sandbox === 'read-only' && result.implementerOutput.trim().length > 0) {
            try {
              const block = contextBlockStore.register(result.implementerOutput);
              contextBlockId = block.id;
            } catch { /* best-effort — store may be at capacity */ }
          }

          const totalActualCostUSD = result.cost.implementerUsd + (result.cost.reviewerUsd ?? 0);

          // Compute main-model equivalent cost using the caller's declared main model
          // (from X-MMA-Main-Model header) — same computation as to-wire-record.ts
          const mainModelId = ctx.mainModel ?? deps.config.agents[implTier]?.model ?? 'unknown';
          const mainCard = resolveRateCard(mainModelId);
          const totalUsage = {
            inputTokens: result.implementerTurn.usage.inputTokens + (result.reviewerTurn?.usage.inputTokens ?? 0),
            outputTokens: result.implementerTurn.usage.outputTokens + (result.reviewerTurn?.usage.outputTokens ?? 0),
            cachedReadTokens: result.implementerTurn.usage.cachedReadTokens + (result.reviewerTurn?.usage.cachedReadTokens ?? 0),
            cachedNonReadTokens: result.implementerTurn.usage.cachedNonReadTokens + (result.reviewerTurn?.usage.cachedNonReadTokens ?? 0),
          };
          const mainEquivalentUSD = mainCard ? priceTokens(totalUsage, mainCard) : null;
          const costDeltaVsMain = mainEquivalentUSD !== null ? mainEquivalentUSD - totalActualCostUSD : null;

          const resultObj = {
            task: {
              taskId,
              type: input.type,
              ...(input.type === 'audit' && (input as Record<string, unknown>).subtype
                ? { subtype: (input as Record<string, unknown>).subtype }
                : {}),
              status: result.status,
            },
            output: {
              summary: result.reviewerOutput ?? tryParseJson(result.reviewerTurn?.output ?? result.implementerOutput),
              filesChanged: result.worktree?.filesChanged ?? result.implementerTurn.filesWritten,
              contextBlockId,
            },
            execution: {
              sessions: {
                implementer: result.sessions.implementer.sessionId,
                reviewer: result.sessions.reviewer?.sessionId ?? null,
              },
              worktree: result.worktree
                ? {
                    merged: result.status !== 'failed',
                    branch: result.worktree.branch,
                    ...(result.status === 'failed' ? { path: result.worktree.path } : {}),
                  }
                : null,
            },
            metrics: {
              totalDurationMs: durationMs,
              totalCostUsd: totalActualCostUSD,
              implementer: {
                durationMs: result.implementerTurn.durationMs,
                costUsd: result.cost.implementerUsd,
                usage: result.implementerTurn.usage,
              },
              reviewer: result.reviewerTurn ? {
                durationMs: result.reviewerTurn.durationMs,
                costUsd: result.cost.reviewerUsd!,
                usage: result.reviewerTurn.usage,
              } : null,
              totalUsage: totalUsage,
              mainEquivalentCostUsd: mainEquivalentUSD,
              savedVsMainCostUsd: costDeltaVsMain,
            },
            raw: {
              implementer: result.implementerOutput,
              reviewer: result.reviewerTurn?.output ?? null,
            },
            error: result.reviewerParseError
              ? { code: 'reviewer_parse_failed' as const, message: result.reviewerParseError }
              : result.status === 'failed'
                ? { code: 'pipeline_failed' as const, message: 'Pipeline completed with failed status' }
                : null,
          };

          // Emit telemetry via the bus — TelemetryUploader picks up the
          // sealed envelope snapshot and enqueues a wire record.
          try {
            const implModelId = deps.config.agents[implTier]?.model ?? 'unknown';
            const revModelId = deps.config.agents[revTier]?.model ?? 'unknown';
            const envelope = buildEnvelopeSnapshot(
              taskId, input.type, result,
              implTier, revTier, reviewPolicy,
              implModelId, revModelId, mainModelId,
              cwd, durationMs,
              researchCtx?.sourcesUsed ?? [],
            );
            deps.bus.emitEnvelopeSnapshot(envelope, 'seal');
          } catch (telErr) {
            process.stderr.write(
              `[mma] event=telemetry_emit_error ts=${new Date().toISOString()} task=${taskId} err="${(telErr instanceof Error ? telErr.message : String(telErr)).replace(/"/g, '\\"')}"\n`,
            );
          }

          if (result.status === 'failed') {
            deps.taskRegistry.fail(taskId, resultObj);
            deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: 'pipeline_failed', error_message: 'Pipeline completed with failed status' } });
            process.stderr.write(
              `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
            );
          } else {
            deps.taskRegistry.complete(taskId, resultObj);
            deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs } });
            process.stderr.write(
              `[mma] event=task_completed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          const errObj = {
            code: 'runner_crash',
            message,
            ...(stack !== undefined && { stack }),
          };
          deps.taskRegistry.fail(taskId, errObj);
          const durationMs = Date.now() - startedAtMs;
          deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
          process.stderr.write(
            `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
          );
        }
      })();
    });
  };
}

export function buildTaskPollHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const taskId = params.taskId;
    if (!taskId) {
      sendError(res, 400, 'missing_task_id', 'taskId required');
      return;
    }

    const entry = deps.taskRegistry.get(taskId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Task ${taskId} not found`);
      return;
    }

    if (deps.taskRegistry.isTerminal(taskId)) {
      sendJson(res, 200, entry.result ?? { taskId, status: entry.state, error: null });
    } else {
      const now = Date.now();
      const polling: Record<string, unknown> = {
        taskId,
        status: 'running',
        phase: entry.phase ?? 'implementing',
        elapsedMs: now - entry.startedAt,
        phaseElapsedMs: entry.phaseStartedAt ? now - entry.phaseStartedAt : now - entry.startedAt,
        startedAt: new Date(entry.startedAt).toISOString(),
      };
      if (entry.tool === 'execute_plan' && entry.totalTasks != null) {
        polling.totalTasks = entry.totalTasks;
      }
      sendJson(res, 202, polling);
    }
  };
}
