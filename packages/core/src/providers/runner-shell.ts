import type { RunInput, RunResult, ExecutionContext, ToolCall } from './runner-shell-types.js';
import type { RunnerAdapter, AdapterTurnResult, AdapterTurnRecord, AdapterCapabilities } from './runner-adapter.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [],
};

// Tool-name sets are centralized in `tool-name-sets.ts` so the
// runner-shell + running-headline-sink can't drift. Note: this
// runner's READ list is intentionally narrower than the central
// READ_TOOL_NAMES — runner-shell tracks filesRead by extractable
// path, and grep/glob/listFiles don't have a single "file" arg. The
// central set is for the polling headline's read activity counter,
// which counts every read-class tool call regardless of args.
import { WRITE_TOOL_NAMES, SHELL_TOOL_NAMES } from './tool-name-sets.js';
import { filterValidWritePath } from './file-tracker.js';
const READ_TOOL_NAMES = new Set(['readFile', 'read_file']);

function extractPathFromToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath']) {
    const v = obj[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Heuristic: does the given shell command write to the filesystem?
 *
 * Gap 11 fix (4.0.3+): the polling headline tracks file writes by tool
 * name (writeFile/write_file/edit_file). Workers that bypass these and
 * write via run_shell (cat >, sed -i, tee, etc.) used to show "0 write"
 * for the entire run despite actively producing artifacts. This
 * heuristic looks for common write patterns in the command string;
 * false positives are acceptable (operator gets a slightly noisy count)
 * but false negatives are not (the headline lies about progress).
 *
 * Patterns detected:
 *   - Output redirects: `> file`, `>> file`, `&> file`, `>| file`
 *   - Heredoc to file: `<<EOF > file`, `cat <<...> file`
 *   - `sed -i` / `sed -i ''` (in-place edit)
 *   - `awk -i inplace` / `gawk -i inplace`
 *   - `tee file`, `tee -a file`
 *   - `cp/mv/touch/install` (file creation/moves)
 *   - `mkdir`, `rm`, `chmod`, `chown` (filesystem mutation)
 *   - `git checkout/reset/restore/pull/merge` (modifies files)
 *   - `python/node -c '... open(... "w") ...'` is NOT detected — too
 *     ambiguous; keeps false-positive rate low.
 */
const SHELL_WRITE_PATTERNS: RegExp[] = [
  /[^&|>]>>?\s*[^&|>\s]/,                // > file or >> file (excluding 2>&1, &> handled below)
  /&>\s*[^&|>\s]/,                       // &> file
  />\|\s*[^&|>\s]/,                      // >| file
  /\bsed\s+(?:-[a-z]*i[a-z]*\b|--in-place\b)/i,  // sed -i / sed --in-place
  /\b(?:awk|gawk|nawk)\s+-i\s+inplace\b/i,
  /\btee\b/,
  /\b(?:cp|mv|touch|install|ln)\s+/,
  /\bmkdir\s+/,
  /\brm\s+/,
  /\bchmod\s+/,
  /\bchown\s+/,
  /\bgit\s+(?:checkout|reset|restore|pull|merge|clean|stash|cherry-pick|rebase|apply)\b/,
  /\bnpm\s+(?:install|i|ci|uninstall|update|run\s+build|run\s+test)\b/,
  /\bpnpm\s+(?:install|add|remove|update|run)\b/,
  /\byarn\s+(?:install|add|remove|upgrade)\b/,
];

export function shellCommandWritesFs(command: string): boolean {
  if (!command || command.length === 0) return false;
  for (const pattern of SHELL_WRITE_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function extractShellCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'shell']) {
    const v = obj[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.join(' ');
  }
  return undefined;
}

export class RunnerShell {
  constructor(
    private adapter: RunnerAdapter,
    /** Default model id used for cost computation when input.model is absent.
     *  Reviewer/annotator engines call shell.run() without setting input.model,
     *  so without this default every reviewer-side stage would record costUSD=null. */
    private defaultModel?: string,
  ) {}

  async run(input: RunInput): Promise<RunResult> {
    const startMs = Date.now();
    const modelForCost = input.model ?? this.defaultModel;
    const ctx: ExecutionContext = { cwd: input.cwd, callCache: new Map() };
    const usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
    const allToolCalls: ToolCall[] = [];
    // A4b.0 (4.2.2+): dedupe filesRead/filesWritten by unique path. Same
    // path written N times within a task = 1 entry. Tool-call count (the
    // raw activity counter via `allToolCalls`) is intentionally NOT
    // deduped — every invocation is billable. Spec reviewers reason
    // about file CHANGES, not tool ACTIVITY, so the per-path dedupe is
    // what they want to see.
    const filesReadSet = new Set<string>();
    const filesWrittenSet = new Set<string>();
    // A4b.1 (4.2.2+): entries the path-validity filter rejected — shell
    // heredoc commands, absolute paths, paths with shell metacharacters.
    // Kept separately so the lifecycle layer can drain them into its
    // diagnostics field for the `writes_unverifiable` daemon-log message
    // (see A4b.2). NOT included in the public filesWritten array — those
    // entries are not real, verifiable disk artifacts.
    const filesWrittenRejectedSet = new Set<string>();
    let turns = 0;
    const history: AdapterTurnRecord[] = [];
    let finalText = '';
    let stoppedByAdapter = false;

    // Common fields stamped on every emitted bus event so VerboseLogChannel
    // surfaces enough context for an operator to see which run a line belongs
    // to without grepping back to the originating request.
    const baseEventFields = {
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
      providerType: this.adapter.providerType,
    };

    for (let turn = 0; turn < input.maxTurns; turn++) {
      if (input.abortSignal?.aborted) {
        return {
          workerStatus: 'blocked',
          finalAssistantText: '',
          toolCalls: allToolCalls,
          usage,
          errorCode: 'aborted',
          turns,
          durationMs: Date.now() - startMs,
          filesRead: [...filesReadSet],
          filesWritten: [...filesWrittenSet],
          filesWrittenRejected: [...filesWrittenRejectedSet],
          costUSD: computeCost(modelForCost, usage),
        };
      }

      // Three-event-per-turn lifecycle so verbose stderr surfaces every
      // state change. `runner_turn_started` fires before the LLM call so
      // operators see "now waiting on the model" in real time. After the
      // adapter returns, `runner_response_received` carries the raw
      // provider response shape (stop_reason + content-block tally). After
      // local tool execution, `runner_turn_completed` carries per-tool
      // counts (read vs write etc.) so operators can see what work the
      // model is doing without grepping the JSONL log.
      input.bus?.emit({
        event: 'runner_turn_started',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
      });
      turns++;

      const turnResult: AdapterTurnResult = await this.adapter.turn({
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        priorTurns: history,
        toolDefinitions: input.toolDefinitions,
        capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
        abortSignal: input.abortSignal,
        deadlineMs: input.deadlineMs,
        ...(input.cacheControl && { cacheControl: input.cacheControl }),
      });

      usage.inputTokens += turnResult.usage.inputTokens;
      usage.outputTokens += turnResult.usage.outputTokens;
      usage.cachedReadTokens += turnResult.usage.cachedReadTokens;
      usage.cachedNonReadTokens += turnResult.usage.cachedNonReadTokens;

      finalText = turnResult.assistantText;

      // Diagnostic visibility (4.2.3+): include the assistant text on
      // `runner_response_received` when verbose logging is meaningful.
      // Pre-fix, only `assistantTextLen` was emitted, which made it
      // impossible to tell from the log alone WHY a spec/quality review
      // rejected (the reviewer's rejection text lived only in the live
      // worker output, never in any persistent log). Now: full text is
      // present on every turn, capped at 16 KB so a runaway implementer
      // narrative doesn't bloat the JSONL log. 16 KB is comfortably
      // larger than every reviewer/annotator response observed in
      // production (typical ~500 bytes; 99th percentile <8 KB).
      const ASSISTANT_TEXT_LOG_CAP = 16 * 1024;
      const txt = turnResult.assistantText ?? '';
      const truncated = txt.length > ASSISTANT_TEXT_LOG_CAP;
      const assistantText = truncated ? txt.slice(0, ASSISTANT_TEXT_LOG_CAP) : txt;
      input.bus?.emit({
        event: 'runner_response_received',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
        finishReason: turnResult.finishReason,
        assistantTextLen: turnResult.assistantText.length,
        ...(assistantText.length > 0 && { assistantText }),
        ...(truncated && { assistantTextTruncated: true }),
        toolCallCount: turnResult.toolCalls.length,
        ...(turnResult.responseShape?.stopReason !== undefined && { stopReason: turnResult.responseShape.stopReason }),
        ...(turnResult.responseShape?.contentBlocks !== undefined && { contentBlocks: turnResult.responseShape.contentBlocks }),
        usage: turnResult.usage,
      });

      const turnRecord: AdapterTurnRecord = {
        assistantText: turnResult.assistantText,
        toolCalls: [],
      };

      const willTerminate = turnResult.toolCalls.length === 0;
      if (willTerminate) {
        history.push(turnRecord);
        stoppedByAdapter = true;
      } else {
        for (const call of turnResult.toolCalls) {
          const def = input.toolDefinitions.find(d => d.name === call.name);
          let result: unknown;
          if (!def) {
            result = { error: `unknown tool: ${call.name}` };
          } else {
            try {
              result = await def.execute(call.input, ctx);
            } catch (err) {
              result = { error: `tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
          const enriched = { name: call.name, input: call.input, result };
          allToolCalls.push(enriched);
          turnRecord.toolCalls.push(enriched);
          const succeeded = !(typeof result === 'object' && result !== null && 'error' in (result as Record<string, unknown>));
          if (!succeeded) {
            const errMsg = (result as { error?: string }).error ?? '(no error message)';
            const inputPreview = JSON.stringify(call.input).slice(0, 200);
            process.stderr.write(`[runner-shell] tool ${call.name} FAILED — err=${errMsg} input=${inputPreview}\n`);
          }
          if (succeeded) {
            const path = extractPathFromToolInput(call.input);
            if (READ_TOOL_NAMES.has(call.name) && path) filesReadSet.add(path);
            else if (WRITE_TOOL_NAMES.has(call.name) && path) {
              // A4b.1: validate before adding to the public array. Any
              // entry that fails the path-validity check (absolute
              // paths, shell metacharacters) goes to the rejected pile —
              // not silently dropped, but kept for the daemon-log
              // diagnostic in A4b.2.
              if (filterValidWritePath(path)) filesWrittenSet.add(path);
              else filesWrittenRejectedSet.add(path);
            } else if (SHELL_TOOL_NAMES.has(call.name)) {
              // A4b.1 (4.2.2+) — supersedes Gap-11 (4.0.3+). Pre-fix,
              // workers using run_shell heredocs (cat >, tee, etc.)
              // had a synthetic `shell:<command>` entry added to
              // filesWritten so the headline showed non-zero write
              // activity. That conflated "shell tried to write" with
              // "real artifact landed", which broke the spec
              // reviewer's diff-against-baseline reasoning. Now: the
              // shell entry goes ONLY to the rejected pile (used for
              // diagnostics + the writes_unverifiable downgrade in
              // A4b.2). The headline's `shellWrites` counter (separate,
              // emitted to the bus and tracked by RunningHeadlineSink)
              // continues to show the activity signal.
              const command = extractShellCommand(call.input);
              if (command && shellCommandWritesFs(command)) {
                filesWrittenRejectedSet.add(`shell:${command.slice(0, 80)}`);
              }
            }
          }
        }
        history.push(turnRecord);
      }

      // Per-tool counts for THIS turn so operators see "5 readFile, 1 grep"
      // instead of the bare "tool_call_count=6". The user can immediately
      // tell read vs write activity without inspecting the JSONL log.
      const toolCallsByName: Record<string, number> = {};
      // Gap 11 (4.0.3+): also count shell calls that wrote to the
      // filesystem so the headline reflects worker-produced artifacts
      // even when the worker bypassed write_file/edit_file.
      let shellWritesThisTurn = 0;
      // A4b.0 (4.2.2+): emit per-turn unique read/write PATHS so the
      // headline sink can dedupe across turns. Without these, the sink
      // counts every tool invocation as a separate read/write — a
      // worker that writes to `foo.ts` 5 times shows "5 write" in the
      // headline even though only 1 file changed. Empty arrays are
      // valid and short-circuit at the sink.
      const pathsReadThisTurn = new Set<string>();
      const pathsWrittenThisTurn = new Set<string>();
      for (const tc of turnResult.toolCalls) {
        toolCallsByName[tc.name] = (toolCallsByName[tc.name] ?? 0) + 1;
        const path = extractPathFromToolInput(tc.input);
        if (READ_TOOL_NAMES.has(tc.name) && path) pathsReadThisTurn.add(path);
        else if (WRITE_TOOL_NAMES.has(tc.name) && path) pathsWrittenThisTurn.add(path);
        if (SHELL_TOOL_NAMES.has(tc.name)) {
          const cmd = extractShellCommand(tc.input);
          if (cmd && shellCommandWritesFs(cmd)) shellWritesThisTurn += 1;
        }
      }

      input.bus?.emit({
        event: 'runner_turn_completed',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
        terminated: willTerminate,
        toolCallCount: turnResult.toolCalls.length,
        ...(turnResult.toolCalls.length > 0 && { toolCalls: toolCallsByName }),
        ...(pathsReadThisTurn.size > 0 && { pathsReadThisTurn: [...pathsReadThisTurn] }),
        ...(pathsWrittenThisTurn.size > 0 && { pathsWrittenThisTurn: [...pathsWrittenThisTurn] }),
        ...(shellWritesThisTurn > 0 && { shellWrites: shellWritesThisTurn }),
      });

      if (willTerminate) break;
    }

    // Empty-output regression guard (4.0.3). The 4.0.x runner-shell
    // unconditionally reported `workerStatus: 'done'` whenever the adapter
    // returned no tool calls — even when assistantText was empty. Combined
    // with the anthropic-messages adapter's text-only extraction, a
    // reasoning model that emitted thinking blocks with no text block (or
    // any provider that returned end_turn with empty content) silently
    // produced an "ok" RunResult carrying `output: ''`. The reviewer
    // engine then approved that empty output and the audit/delegate
    // looked successful while emitting nothing useful.
    //
    // 3.12.7's claude-agent-sdk owned the agent loop and didn't have this
    // failure mode. This branch restores the missing check: stopping with
    // empty narrative AND no tool calls is `incomplete`, surfaced as a
    // structured error with errorCode `empty_output` so callers can tell
    // the difference between "model finished cleanly" and "model returned
    // nothing usable".
    if (stoppedByAdapter && finalText.trim() === '' && allToolCalls.length === 0) {
      return {
        workerStatus: 'failed',
        finalAssistantText: '',
        toolCalls: allToolCalls,
        usage,
        errorCode: 'empty_output',
        turns,
        durationMs: Date.now() - startMs,
        filesRead: [...filesReadSet],
        filesWritten: [...filesWrittenSet],
        filesWrittenRejected: [...filesWrittenRejectedSet],
        costUSD: computeCost(modelForCost, usage),
      };
    }

    return {
      workerStatus: stoppedByAdapter ? 'done' : 'blocked',
      finalAssistantText: finalText,
      toolCalls: allToolCalls,
      usage,
      ...(stoppedByAdapter ? {} : { errorCode: 'max_turns_exhausted' }),
      turns,
      durationMs: Date.now() - startMs,
      filesRead: [...filesReadSet],
      filesWritten: [...filesWrittenSet],
      filesWrittenRejected: [...filesWrittenRejectedSet],
      costUSD: computeCost(modelForCost, usage),
    };
  }

  /**
   * Cache-warmer call: sends one minimal turn with the cached prefix so the
   * upstream provider's prompt cache writes the prefix. Subsequent fan-out
   * sub-workers using the same prefix serve from cache.
   *
   * The user message is a single token ("ready") and the assistant response
   * is discarded. For providers that don't honor `cache_control` (codex,
   * future providers), this still runs but produces no measurable cache
   * benefit.
   *
   * Bounded by an internal 10-min hard cap (5-min soft warning) so a slow
   * or hanging warmer cannot blow the route's overall wall-clock. On cap
   * hit, the warmer returns with capHit=true and the dispatcher proceeds
   * to fan-out WITHOUT cache priming — sub-workers will pay full input
   * cost but the route still completes (correctness > optimization).
   */
  async prime(systemPrompt: string, opts: PrimeOptions): Promise<PrimeResult> {
    const startMs = Date.now();

    // Per-warmer wall-clock guard: own hard cap, independent of the
    // task-level abortSignal. Combined into one signal that the adapter sees.
    const warmerAbort = new AbortController();
    const combinedAbort = new AbortController();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) combinedAbort.abort();
      else opts.abortSignal.addEventListener('abort', () => combinedAbort.abort(), { once: true });
    }
    warmerAbort.signal.addEventListener('abort', () => combinedAbort.abort(), { once: true });

    let capHit = false;
    const softTimer = setTimeout(() => {
      opts.bus?.emit({
        event: 'criteria_fanout_warm_soft_warning',
        ts: new Date().toISOString(),
        ...(opts.batchId !== undefined && { batchId: opts.batchId }),
        ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
        elapsedMs: WARMER_SOFT_WARN_MS,
        remainingMs: WARMER_HARD_CAP_MS - WARMER_SOFT_WARN_MS,
      });
    }, WARMER_SOFT_WARN_MS);
    const hardTimer = setTimeout(() => {
      capHit = true;
      opts.bus?.emit({
        event: 'criteria_fanout_warm_cap_hit',
        ts: new Date().toISOString(),
        ...(opts.batchId !== undefined && { batchId: opts.batchId }),
        ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
        elapsedMs: WARMER_HARD_CAP_MS,
      });
      warmerAbort.abort();
    }, WARMER_HARD_CAP_MS);

    try {
      const turnResult = await this.adapter.turn({
        systemPrompt,
        userMessage: 'ready',
        priorTurns: [],
        toolDefinitions: [],
        capabilities: opts.capabilities ?? { ...DEFAULT_CAPABILITIES, thinking: false },
        abortSignal: combinedAbort.signal,
        ...(opts.deadlineMs !== undefined && { deadlineMs: opts.deadlineMs }),
        ...(opts.cacheControl && { cacheControl: opts.cacheControl }),
      });
      const durationMs = Date.now() - startMs;
      // The warmer can't reliably tell whether the upstream actually wrote
      // the cache. cacheControlSent reports we ATTEMPTED to register;
      // confirmation comes from sub-workers' cachedReadTokens.
      const cacheControlSent = !capHit && opts.cacheControl !== undefined;
      opts.bus?.emit({
        event: 'criteria_fanout_warm_complete',
        ts: new Date().toISOString(),
        ...(opts.batchId !== undefined && { batchId: opts.batchId }),
        ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
        ...(opts.tier !== undefined && { tier: opts.tier }),
        ...(opts.stageLabel !== undefined && { stageLabel: opts.stageLabel }),
        durationMs,
        cacheControlSent,
        capHit,
        warmerInputTokens: turnResult.usage.inputTokens,
        warmerCachedNonReadTokens: turnResult.usage.cachedNonReadTokens ?? 0,
      });
      return {
        cacheControlSent,
        capHit,
        durationMs,
        usage: {
          inputTokens: turnResult.usage.inputTokens,
          outputTokens: turnResult.usage.outputTokens,
          cachedReadTokens: turnResult.usage.cachedReadTokens ?? 0,
          cachedNonReadTokens: turnResult.usage.cachedNonReadTokens ?? 0,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      // On cap-hit, swallow the abort and return a synthesized result so
      // the dispatcher proceeds to fan-out without cache (correct, just
      // slower). Real errors (transport, etc.) re-throw — the dispatcher
      // currently doesn't catch warmer errors but a future caller might.
      if (capHit) {
        opts.bus?.emit({
          event: 'criteria_fanout_warm_complete',
          ts: new Date().toISOString(),
          ...(opts.batchId !== undefined && { batchId: opts.batchId }),
          ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
          durationMs,
          cacheControlSent: false,
          capHit: true,
          warmerInputTokens: 0,
          warmerCachedNonReadTokens: 0,
        });
        return {
          cacheControlSent: false,
          capHit: true,
          durationMs,
          usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        };
      }
      throw err;
    } finally {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    }
  }
}

/** Per-warmer wall-clock guard. After this, the warmer's abortSignal
 *  fires and prime() returns with capHit=true; the dispatcher proceeds
 *  to fan-out without cache priming. */
const WARMER_HARD_CAP_MS = 10 * 60 * 1000;
const WARMER_SOFT_WARN_MS = 5 * 60 * 1000;

export interface PrimeOptions {
  cwd: string;
  cacheControl?: { type: 'ephemeral' };
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  capabilities?: AdapterCapabilities;
  bus?: import('../events/event-emitter.js').EventEmitter;
  batchId?: string;
  taskIndex?: number;
  tier?: string;
  stageLabel?: string;
}

export interface PrimeResult {
  /** Whether the warmer attempted to register a cacheable prefix
   *  (i.e. opts.cacheControl was set and the call returned). The actual
   *  cache effectiveness surfaces in subsequent sub-worker
   *  cachedReadTokens, NOT here — see criteria_fanout_summary's
   *  totalCachedReadTokens / cacheHitConfirmed. */
  cacheControlSent: boolean;
  /** True iff the warmer hit the 10-min hard cap and was force-aborted.
   *  Dispatcher proceeds to fan-out anyway; sub-workers pay full input
   *  cost since no cache was primed. */
  capHit: boolean;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
}

function computeCost(model: string | undefined, usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number }): number | null {
  const card = resolveRateCard(model ?? null);
  if (!card) return null;
  return priceTokens(usage, card);
}
