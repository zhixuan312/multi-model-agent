import OpenAI from 'openai';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import { getCodexAuth } from '../auth/codex-oauth.js';
import {
  withTimeout,
  computeCostUSD,
  type RunResult,
  type RunOptions,
  type ProviderConfig,
  type ProgressEvent,
} from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations, type ToolImplementations } from '../tools/definitions.js';
import { TextScratchpad } from '../tools/scratchpad.js';
import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  buildBudgetPressureNudge,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateCompletion,
  buildRePrompt,
  sameDegenerateOutput,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  logWatchdogEvent,
} from './supervision.js';
import { injectionTypeFor } from './injection-type.js';
import { classifyError } from './error-classification.js';
import { findModelProfile } from '../routing/model-profiles.js';
import type { SandboxPolicy } from '../types.js';

// CODEX_DEBUG=1 causes the runner to log raw HTTP request/response bodies to
// stderr. Those bodies routinely include the user's prompt, file contents,
// tool arguments, and other sensitive data — fine for local debugging,
// dangerous in any deployment that ships logs anywhere. Surface a one-time
// warning at module load so an operator who flipped the env var without
// thinking sees it immediately.
if (process.env.CODEX_DEBUG === '1') {
  // eslint-disable-next-line no-console
  console.warn(
    '[multi-model-agent] WARNING: CODEX_DEBUG=1 is set. Raw request/response ' +
      'bodies (including prompts and file contents) will be logged to stderr. ' +
      'Disable in any environment where logs may be retained or shared.',
  );
}

/**
 * Hard cap on supervision re-prompts before we give up and salvage. Three is
 * the value chosen in the spec (A.2.2); mirrors openai-runner and claude-runner.
 */
const MAX_SUPERVISION_RETRIES = 3;

/**
 * Holds the raw body text of the last HTTP response that returned a 4xx/5xx.
 * The OpenAI SDK wraps errors into APIError but strips the body text when it
 * can't be parsed as JSON, leaving "400 status code (no body)". We capture it
 * ourselves via a custom fetch so we can surface actionable diagnostics.
 */
export interface RawErrorCapture {
  status: number;
  bodyText: string;
  url: string;
  requestBodyPreview?: string;
}

export function createCodexClient(capture?: { last?: RawErrorCapture }): OpenAI {
  const debug = process.env.CODEX_DEBUG === '1';

  // A custom fetch that tees error-response bodies into `capture`.
  const wrappedFetch: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok && capture) {
      const cloned = res.clone();
      let bodyText = '';
      try { bodyText = await cloned.text(); } catch { /* ignore */ }
      capture.last = {
        status: res.status,
        bodyText,
        url: String(url),
        requestBodyPreview: typeof init?.body === 'string' ? init.body.slice(0, 2000) : undefined,
      };
      if (debug) {
        // eslint-disable-next-line no-console
        console.error('[codex-runner] HTTP', res.status, String(url));
        // eslint-disable-next-line no-console
        if (bodyText) console.error('[codex-runner] body:', bodyText.slice(0, 1000));
        // eslint-disable-next-line no-console
        if (typeof init?.body === 'string') console.error('[codex-runner] request:', init.body.slice(0, 1000));
      }
    }
    return res;
  };

  // Try Codex OAuth first — route through chatgpt.com backend API
  const auth = getCodexAuth();
  if (auth) {
    return new OpenAI({
      apiKey: auth.accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: {
        'chatgpt-account-id': auth.accountId,
      },
      fetch: wrappedFetch,
    });
  }

  // Fall back to OPENAI_API_KEY env var — uses standard api.openai.com
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAI({ apiKey, fetch: wrappedFetch });
  }

  throw new Error(
    'No Codex credentials found. Run `codex login` or set OPENAI_API_KEY environment variable.',
  );
}

/**
 * Tool definitions for the Codex Responses API.
 *
 * These mirror src/tools/openai-adapter.ts but use JSON schema directly
 * instead of zod (the Responses API tool format does not accept zod schemas).
 */
interface CodexTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function buildCodexTools(impl: ToolImplementations, sandboxPolicy: SandboxPolicy): CodexTool[] {
  const tools: CodexTool[] = [
    {
      name: 'read_file',
      description: 'Read the contents of a file at the given path. Returns the full file content as a string.',
      parameters: z.toJSONSchema(z.object({
        path: z.string().describe('Absolute or relative file path'),
      })) as Record<string, unknown>,
      execute: async (args) => impl.readFile(args.path as string),
    },
    {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed. Overwrites existing files.',
      parameters: z.toJSONSchema(z.object({
        path: z.string().describe('File path to write to'),
        content: z.string().describe('Content to write'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        await impl.writeFile(args.path as string, args.content as string);
        return `File written: ${args.path}`;
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern in the working directory.',
      parameters: z.toJSONSchema(z.object({
        pattern: z.string().describe('Glob pattern (e.g., "*.ts", "src/**/*.js")'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const files = await impl.glob(args.pattern as string);
        return files.join('\n') || 'No files found.';
      },
    },
    {
      name: 'grep',
      description: 'Search for a pattern in a file. Returns matching lines with line numbers.',
      parameters: z.toJSONSchema(z.object({
        pattern: z.string().describe('Search pattern (regex)'),
        path: z.string().describe('File path to search in'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const result = await impl.grep(args.pattern as string, args.path as string);
        return result || 'No matches found.';
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories at the given path. Directories have a trailing "/".',
      parameters: z.toJSONSchema(z.object({
        path: z.string().default('.').describe('Directory path to list'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const entries = await impl.listFiles((args.path as string) ?? '.');
        return entries.join('\n') || 'Empty directory.';
      },
    },
  ];

  if (sandboxPolicy !== 'cwd-only') {
    tools.push({
      name: 'run_shell',
      description: 'Execute a shell command and return stdout, stderr, and exit code. Use for running tests, installing packages, etc.',
      parameters: z.toJSONSchema(z.object({
        command: z.string().describe('Shell command to execute'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const result = await impl.runShell(args.command as string);
        return JSON.stringify(result);
      },
    });
  }

  return tools;
}

export async function runCodex(
  prompt: string,
  options: RunOptions,
  providerConfig: ProviderConfig,
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' },
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? providerConfig.maxTurns ?? defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? providerConfig.timeoutMs ?? defaults.timeoutMs;
  const toolMode = options.tools ?? defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const sandboxPolicy = options.sandboxPolicy ?? providerConfig.sandboxPolicy ?? 'cwd-only';
  const effort = options.effort ?? providerConfig.effort;

  const abortController = new AbortController();

  // --- Progress event emission (Task 11) ----------------------------------
  //
  // `onProgress` is already wrapped in `safeSink` by the orchestrator
  // (Task 8), so any throw from the consumer callback is swallowed
  // upstream and cannot corrupt this loop. We do not need to wrap it
  // again here.
  const onProgress = options.onProgress;
  const emit = (event: ProgressEvent): void => {
    if (onProgress) onProgress(event);
  };

  // Accumulated state (hoisted so the timeout callback can read partial
  // progress, AND so the FileTracker callback closure — constructed below
  // — can read the running turn count at firing time).
  //
  // Turn attribution for tool calls: in codex-runner, tool calls fire in
  // the tool-execution loop AFTER the model's stream for that turn has
  // completed but BEFORE the next iteration of `while` starts. The `turns`
  // variable already reflects the current turn at that point (it was
  // incremented at the top of the iteration), so the callback can read it
  // directly — no +1 offset.
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  const tracker = new FileTracker((summary) => {
    emit({ kind: 'tool_call', turn: turns, toolSummary: summary });
  });
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);

  const codexTools = toolMode === 'full' ? buildCodexTools(toolImpls, sandboxPolicy) : [];
  const toolsByName = new Map(codexTools.map(t => [t.name, t]));
  const responsesTools = codexTools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));

  // Auto-enable web_search for codex unless the user explicitly set hostedTools
  // (including an explicit empty array to opt out). This keeps the capability
  // matrix's claim that codex has web_search true at default settings — the
  // user's guiding principle is to minimize required config.
  const configuredHostedTools = providerConfig.hostedTools ?? ['web_search'];
  const hostedTools = toolMode === 'full'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? configuredHostedTools.map(t => ({ type: t } as any))
    : [];
  const allTools = [...responsesTools, ...hostedTools];

  // --- Prevention layer: system prompt + budget hint ---
  //
  // buildSystemPrompt() is deliberately static and parameter-free (same
  // decision as openai-runner and claude-runner: Task 1 review rejected
  // provider/maxTurns options). The budget hint is prepended to the user
  // prompt so the model sees it as part of its task brief, while the system
  // prompt is threaded through the Responses API `instructions` field.
  const systemPrompt = buildSystemPrompt();
  const budgetHint = buildBudgetHint({ maxTurns });
  const promptWithBudgetHint = `${budgetHint}\n\n${prompt}`;

  // --- onInitialRequest (Task 12) ----------------------------------------
  //
  // Fire once per attempt with the exact concatenation of the first request
  // body the model will see. Matches openai-runner and claude-runner so the
  // hash is cross-runner stable for an identical prompt.
  if (options.onInitialRequest) {
    const initialRequestBody = `${systemPrompt}\n\n${promptWithBudgetHint}`;
    try {
      options.onInitialRequest({
        lengthChars: initialRequestBody.length,
        sha256: createHash('sha256').update(initialRequestBody).digest('hex'),
      });
    } catch {
      // Swallow — a broken callback must not affect dispatch.
    }
  }

  // --- Scratchpad: buffers every text emission the codex backend streams
  // through our loop. Every termination path (ok / incomplete / max_turns /
  // error / timeout / force_salvage) salvages `scratchpad.latest()` when
  // the final message is empty or degenerate. ---
  const scratchpad = new TextScratchpad();

  // --- Watchdog: resolve the input-token soft limit once per run ---
  const profile = findModelProfile(providerConfig.model);
  const softLimit = resolveInputTokenSoftLimit(providerConfig, profile);

  const run = async (): Promise<RunResult> => {
    const capture: { last?: RawErrorCapture } = {};
    const client = createCodexClient(capture);
    const input: ResponseInputItem[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: 'user', content: promptWithBudgetHint } as any,
    ];

    let output = '';

    // --- Abort-path investigation (plan Step 2) ---------------------------
    //
    // The 2026-04-10 Fate dispatch captured an error "Request was aborted |
    // last response status: completed". The "completed" suffix was
    // misleading: it was captured from a PREVIOUS successful turn, not the
    // failed one. Mechanism:
    //
    //   1. Turn N's stream emits `response.completed` with status
    //      `'completed'`. We update `lastResponseStatus = 'completed'`.
    //   2. Turn N+1 starts; `client.responses.create(...)` opens a new
    //      stream, but the abort signal fires before any
    //      `response.completed` event is received.
    //   3. The thrown error is caught below. The catch branch reads
    //      `lastResponseStatus` — which is STILL `'completed'` from turn N
    //      — and appends it as "last response status: completed", making
    //      the error look like it originated from a successful response.
    //
    // Fix: track which turn the status was captured on. If the status was
    // NOT captured on the current (failed) turn, drop the suffix. That way
    // we never emit a status that belongs to a different, already-
    // concluded request. Users saw the misleading suffix and wasted time
    // debugging a phantom "the request completed but was aborted" condition
    // that doesn't exist.
    let lastResponseStatus: string | null = null;
    let lastResponseStatusTurn: number | null = null;

    // --- Supervision / watchdog bookkeeping ---
    let supervisionRetries = 0;
    // Initialised to `null` (NOT ''): on the first turn there is no
    // previous degenerate output to compare against, so the same-output
    // early-out must be skipped. Initialising to '' would cause
    // sameDegenerateOutput('', '') to fire on a first-turn empty output
    // and break the loop before any retries run. See openai-runner
    // regression #5.
    let lastDegenerateOutput: string | null = null;
    // High-watermark guard for the watchdog warning nudge — fire at most
    // once per distinct input-token level. Mirrors openai-runner and
    // claude-runner.
    let lastWarnedInputTokens = -1;

    try {
      while (turns < maxTurns) {
        turns++;
        // Emit turn_start AFTER incrementing so `turn` matches the 1-indexed
        // turn number we use everywhere else in this runner (the scratchpad
        // append, watchdog logs, error diagnostics, result.turns).
        emit({ kind: 'turn_start', turn: turns, provider: 'codex' });

        // Codex backend requires streaming. The Codex backend's
        // `response.completed` event does NOT populate `response.output` —
        // we must accumulate content from individual stream events.
        // `instructions` carries the prevention-layer system prompt; the
        // per-run budget hint is already prepended to the first user input.
        const stream = await client.responses.create({
          model: providerConfig.model,
          instructions: systemPrompt,
          input,
          stream: true,
          store: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: allTools.length > 0 ? (allTools as any) : undefined,
          // Honor `effort` when set and not 'none'. Codex backend accepts
          // reasoning.effort for reasoning-capable models (gpt-5-codex, o3, etc.).
          // 'none' skips the reasoning block entirely.
          ...(effort && effort !== 'none' && {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            reasoning: { effort } as any,
          }),
        }, { signal: abortController.signal });

        let textThisTurn = '';
        const toolCalls: Array<{ call_id: string; name: string; arguments: string; item?: unknown }> = [];
        const itemTypesSeen: string[] = [];
        const completedItems: unknown[] = [];
        let sawCompleted = false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const event of stream as any) {
          const et = event?.type as string | undefined;
          if (!et) continue;

          if (et === 'response.output_text.delta') {
            textThisTurn += event.delta ?? '';
          } else if (et === 'response.output_item.added') {
            if (event.item?.type) itemTypesSeen.push(event.item.type);
          } else if (et === 'response.output_item.done') {
            const item = event.item;
            if (item) {
              completedItems.push(item);
              if (item.type === 'function_call') {
                toolCalls.push({
                  call_id: item.call_id,
                  name: item.name,
                  arguments: item.arguments ?? '',
                  item,
                });
              }
            }
          } else if (et === 'response.completed') {
            sawCompleted = true;
            const r = event.response as Response | undefined;
            if (r?.usage) {
              inputTokens += r.usage.input_tokens ?? 0;
              outputTokens += r.usage.output_tokens ?? 0;
            }
            if (r?.status) {
              lastResponseStatus = r.status;
              lastResponseStatusTurn = turns;
            }
          }
        }

        if (process.env.CODEX_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error('[codex-runner] item types streamed:', itemTypesSeen.join(', ') || '(none)');
          // eslint-disable-next-line no-console
          console.error('[codex-runner] text this turn:', JSON.stringify(textThisTurn));
          // eslint-disable-next-line no-console
          console.error('[codex-runner] tool calls:', toolCalls.length);
        }

        if (!sawCompleted) {
          throw new Error('Codex stream ended without a response.completed event');
        }

        // Buffer this turn's text into the scratchpad BEFORE any exit so
        // every termination path (including supervision exhaustion and
        // force_salvage) can salvage it. Codex does not emit <think> tags
        // by default, so there is no stripping step here.
        if (textThisTurn) {
          scratchpad.append(turns, textThisTurn);
          emit({
            kind: 'text_emission',
            turn: turns,
            chars: textThisTurn.length,
            preview: textThisTurn.slice(0, 200),
          });
          output = textThisTurn;
        }

        // Replay only function_call items into the next turn's input.
        //
        // We send `store: false` to the Responses API, which means the server
        // does NOT persist any items it generates (reasoning items with `rs_`
        // ids, message items with `msg_` ids, etc.). Replaying those items
        // wholesale causes a 404 on the next turn:
        //   "Item with id 'rs_...' not found. Items are not persisted when
        //    `store` is set to false."
        //
        // function_call items are part of the tool-call protocol — the next
        // turn needs them so each function_call_output we push can be paired
        // with its originating call_id. We strip the server-generated `id`
        // field and rebuild the item from its protocol fields only, so the
        // server has nothing to look up against unpersisted state.
        //
        // Reasoning, message, and other server-generated items are dropped.
        // The model still sees its previous tool calls + their outputs, which
        // is enough to continue a multi-turn agent loop.
        for (const item of completedItems) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const it = item as any;
          if (it?.type === 'function_call') {
            input.push({
              type: 'function_call',
              call_id: it.call_id,
              name: it.name,
              arguments: it.arguments ?? '',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
          }
        }

        // --- Watchdog checks after tokens are updated -------------------
        const watchdogStatus = checkWatchdogThreshold(inputTokens, softLimit);
        if (watchdogStatus !== 'ok') {
          logWatchdogEvent(watchdogStatus, {
            provider: 'codex',
            model: providerConfig.model,
            turn: turns,
            inputTokens,
            softLimit,
            scratchpadChars: scratchpad.toString().length,
          });
        }
        if (watchdogStatus === 'force_salvage') {
          // `watchdog_force_salvage` is not an injected message — no
          // re-prompt is sent — but observers still want to see exactly
          // why the run is being killed. Emit with contentLengthChars: 0
          // to reflect the "nothing was injected, we just terminated"
          // semantics (mirrors openai-runner and claude-runner).
          emit({
            kind: 'injection',
            injectionType: 'watchdog_force_salvage',
            turn: turns,
            contentLengthChars: 0,
          });
          const salvaged = buildCodexForceSalvageResult({
            tracker,
            scratchpad,
            providerConfig,
            inputTokens,
            outputTokens,
            turns,
            softLimit,
          });
          emit({ kind: 'done', status: salvaged.status });
          return salvaged;
        }
        // Warning-band nudge: fire at most once per distinct input-token
        // high-watermark. Pushed as a user message so the next turn of
        // the codex loop addresses the budget-pressure prompt. We use
        // the shared prevention helper (NOT an inline string) so every
        // runner emits byte-identical wording.
        if (watchdogStatus === 'warning' && inputTokens > lastWarnedInputTokens) {
          lastWarnedInputTokens = inputTokens;
          const warning = buildBudgetPressureNudge({ inputTokens, softLimit });
          input.push({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            role: 'user',
            content: warning,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          emit({
            kind: 'injection',
            injectionType: 'watchdog_warning',
            turn: turns,
            contentLengthChars: warning.length,
          });
        }

        // --- Periodic re-grounding inside the loop ---------------------
        if (turns > 0 && turns % RE_GROUNDING_INTERVAL_TURNS === 0) {
          const reground = buildReGroundingMessage({
            originalPromptExcerpt: prompt,
            currentTurn: turns,
            maxTurns,
            toolCallsSoFar: tracker.getToolCalls().length,
            filesReadSoFar: tracker.getReads().length,
          });
          input.push({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            role: 'user',
            content: reground,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          emit({
            kind: 'injection',
            injectionType: 'reground',
            turn: turns,
            contentLengthChars: reground.length,
          });
        }

        // --- turn_complete: one event per while-iteration. Fires after the
        // watchdog + re-grounding checks have run (so cumulative token
        // counts and any injection events are already on the wire) and
        // BEFORE the supervision branching / tool-execution loop. Every
        // continue/return in the branches below happens AFTER this event,
        // so the sequence "turn_start ... text_emission ... turn_complete"
        // is guaranteed per iteration.
        emit({
          kind: 'turn_complete',
          turn: turns,
          cumulativeInputTokens: inputTokens,
          cumulativeOutputTokens: outputTokens,
        });

        // If the model made no tool calls, the turn ended with either a
        // final answer or a degenerate emission. Wrap in the supervision
        // state machine: valid text is an immediate ok-exit; degenerate
        // either re-prompts (and continues the loop) or — if the retry
        // budget is spent / same-output early-out fires — exits as
        // incomplete with scratchpad salvage.
        if (toolCalls.length === 0) {
          const stripped = textThisTurn; // codex does not emit <think> tags
          const validation = validateCompletion(stripped);

          if (validation.valid) {
            const ok = buildCodexOkResult({
              tracker,
              scratchpad,
              providerConfig,
              inputTokens,
              outputTokens,
              turns,
              output: stripped,
            });
            emit({ kind: 'done', status: ok.status });
            return ok;
          }

          // Same-output early-out: only compare when we have a previous
          // degenerate output. First-turn degeneracy must still get
          // retries — see openai-runner regression #5.
          if (
            (lastDegenerateOutput !== null &&
              sameDegenerateOutput(stripped, lastDegenerateOutput)) ||
            supervisionRetries >= MAX_SUPERVISION_RETRIES
          ) {
            const exhausted = buildCodexIncompleteResult({
              tracker,
              scratchpad,
              providerConfig,
              inputTokens,
              outputTokens,
              turns,
            });
            emit({ kind: 'done', status: exhausted.status });
            return exhausted;
          }

          // Inject the re-prompt as the next user input and continue
          // the loop. The next turn of the codex backend will respond
          // to the re-prompt directly.
          lastDegenerateOutput = stripped;
          supervisionRetries++;
          const rePrompt = buildRePrompt(validation);
          input.push({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            role: 'user',
            content: rePrompt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          emit({
            kind: 'injection',
            injectionType: injectionTypeFor(validation.kind),
            turn: turns,
            contentLengthChars: rePrompt.length,
          });
          continue;
        }

        // Execute tool calls and feed outputs back
        for (const call of toolCalls) {
          const tool = toolsByName.get(call.name);
          let result: string;
          if (!tool) {
            result = `Error: unknown tool "${call.name}"`;
          } else {
            try {
              const args = call.arguments ? JSON.parse(call.arguments) : {};
              result = await tool.execute(args);
            } catch (err) {
              result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: result,
          });
        }
      }

      // Max turns exhausted — salvage any buffered text.
      const maxTurnsResult = buildCodexMaxTurnsResult({
        tracker,
        scratchpad,
        providerConfig,
        inputTokens,
        outputTokens,
        turns,
        maxTurns,
        lastOutput: output,
      });
      emit({ kind: 'done', status: maxTurnsResult.status });
      return maxTurnsResult;
    } catch (err) {
      // OpenAI SDK's APIError carries status/body/headers — surface them
      // since the Codex backend returns 400 with no body on shape mismatches.
      // We also consult `capture.last` which holds the raw HTTP body captured
      // by our wrapped fetch (the SDK strips the body when it can't parse JSON).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const pieces: string[] = [];
      if (err instanceof Error) pieces.push(err.message);
      if (e?.status) pieces.push(`HTTP ${e.status}`);
      if (e?.error) {
        try { pieces.push(`sdk_body=${JSON.stringify(e.error)}`); } catch { /* ignore */ }
      }
      if (capture.last) {
        pieces.push(`raw_status=${capture.last.status}`);
        // Only leak request/response body snippets when debug is explicitly enabled;
        // they may contain sensitive content (prompt, tools, file contents).
        if (process.env.CODEX_DEBUG === '1' && capture.last.bodyText) pieces.push(`raw_body=${capture.last.bodyText.slice(0, 500)}`);
        if (process.env.CODEX_DEBUG === '1' && capture.last.requestBodyPreview) pieces.push(`req_body=${capture.last.requestBodyPreview.slice(0, 500)}`);
      }
      if (e?.requestID) pieces.push(`req_id=${e.requestID}`);
      // Only include `last response status` when it was captured on the
      // CURRENT (failing) turn — otherwise it belongs to a previous,
      // separate request and appending it is actively misleading. See the
      // abort-path investigation comment at the top of `run()`.
      if (lastResponseStatus && lastResponseStatusTurn === turns) {
        pieces.push(`last response status: ${lastResponseStatus}`);
      } else if (lastResponseStatus && lastResponseStatusTurn !== turns) {
        pieces.push(
          `note: a previous request (turn ${lastResponseStatusTurn}) completed with status ` +
          `"${lastResponseStatus}" — it is unrelated to this failure`,
        );
      }
      const detailed = pieces.join(' | ') || String(err);

      // Classify the thrown error into a finer-grained RunStatus. Task 7
      // introduces api_aborted / api_error / network_error alongside the
      // catch-all 'error' status. The turn-scoped `lastResponseStatus`
      // disambiguation above is ORTHOGONAL to this classification: the
      // `detailed` message is still the rich operator-facing diagnostic,
      // and `classifyError` only decides which RunStatus bucket the
      // failure lands in.
      const { status } = classifyError(err);

      // Salvage: if the scratchpad has buffered text from earlier turns,
      // return it as the output. Pre-Task-5 behavior returned only the
      // error string, losing 30k+ tokens of work on abort.
      emit({ kind: 'done', status });
      return {
        output: scratchpad.isEmpty() ? `Sub-agent error: ${detailed}` : scratchpad.latest(),
        status,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
        },
        turns,
        filesRead: tracker.getReads(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        escalationLog: [],
        error: detailed,
      };
    }
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => {
      emit({ kind: 'done', status: 'timeout' });
      return {
        // Preserve any text the scratchpad buffered before the timeout fired.
        // Partial usage is read from the running accumulators hoisted above —
        // hardcoded zeros would discard every token counted on partial turns.
        output: scratchpad.isEmpty() ? `Agent timed out after ${timeoutMs}ms.` : scratchpad.latest(),
        status: 'timeout',
        filesRead: tracker.getReads(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
        },
        turns,
        escalationLog: [],
      };
    },
    abortController,
  );
}

// --- Helpers: canonical return-shape builders -------------------------------
//
// Mirror claude-runner's buildClaudeOkResult / buildClaudeIncompleteResult /
// buildClaudeForceSalvageResult / buildClaudeMaxTurnsResult so every exit
// from the supervision state machine is a one-line call. Each helper folds
// the shared filesRead/filesWritten/toolCalls/usage preamble so the call
// sites in `run()` stay short and symmetric across runners.

interface CodexResultCommonArgs {
  tracker: FileTracker;
  scratchpad: TextScratchpad;
  providerConfig: ProviderConfig;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

function buildCodexOkResult(
  args: CodexResultCommonArgs & { output: string },
): RunResult {
  const { tracker, providerConfig, inputTokens, outputTokens, turns, output } = args;
  return {
    output,
    status: 'ok',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

/**
 * Supervision-exhausted path: retry cap hit or same-output early-out. Prefer
 * scratchpad salvage; fall back to the incomplete diagnostic.
 */
function buildCodexIncompleteResult(
  args: CodexResultCommonArgs,
): RunResult {
  const { tracker, scratchpad, providerConfig, inputTokens, outputTokens, turns } = args;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  return {
    output: scratchpad.isEmpty()
      ? buildCodexIncompleteDiagnostic({
          turns,
          inputTokens,
          outputTokens,
          filesRead,
          filesWritten,
        })
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
    },
    turns,
    filesRead,
    filesWritten,
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildCodexForceSalvageResult(
  args: CodexResultCommonArgs & { softLimit: number },
): RunResult {
  const { tracker, scratchpad, providerConfig, inputTokens, outputTokens, turns, softLimit } = args;
  return {
    output: scratchpad.isEmpty()
      ? `[codex sub-agent forcibly terminated at ${inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildCodexMaxTurnsResult(
  args: CodexResultCommonArgs & { maxTurns: number; lastOutput: string },
): RunResult {
  const { tracker, scratchpad, providerConfig, inputTokens, outputTokens, turns, maxTurns, lastOutput } = args;
  return {
    output: scratchpad.isEmpty()
      ? (lastOutput || `Agent exceeded max turns (${maxTurns}).`)
      : scratchpad.latest(),
    status: 'max_turns',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: computeCostUSD(inputTokens, outputTokens, providerConfig),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildCodexIncompleteDiagnostic(opts: {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  filesRead: string[];
  filesWritten: string[];
}): string {
  return [
    '[codex sub-agent terminated without producing a final answer]',
    '',
    'The model emitted no tool calls and no usable text on its final turn, and',
    'supervision re-prompts did not recover a valid response.',
    '',
    `Turns used:    ${opts.turns}`,
    `Input tokens:  ${opts.inputTokens}`,
    `Output tokens: ${opts.outputTokens}`,
    `Files read:    ${opts.filesRead.length}`,
    `Files written: ${opts.filesWritten.length}`,
    '',
    'Recommended action: re-dispatch with a tighter brief, or escalate provider tier.',
  ].join('\n');
}
