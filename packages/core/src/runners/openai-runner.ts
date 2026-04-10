import { Agent, run as agentRun, setTracingDisabled, OpenAIChatCompletionsModel, MaxTurnsExceededError } from '@openai/agents';
import OpenAI from 'openai';
import { withTimeout, type RunResult, type RunOptions, type ProviderConfig } from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createOpenAITools } from '../tools/openai-adapter.js';

// Disable tracing — not all OpenAI-compatible providers support it
setTracingDisabled(true);

/**
 * Remove `<think>...</think>` reasoning blocks from model output.
 *
 * Several reasoning models (MiniMax, DeepSeek, Qwen variants) emit their
 * chain-of-thought inline wrapped in `<think>...</think>` tags. These are
 * scratch-pad content and should not surface to the caller. Stripping is
 * non-greedy, multi-line, and handles multiple blocks.
 *
 * If the entire input was reasoning (stripping leaves nothing), return an
 * explicit marker instead of an empty string. Silently swallowing
 * "all thinking, no answer" responses leaves the caller with `output: ""`
 * and no idea what happened — see the openai-runner empty-output diagnostic.
 */
export function stripThinkingTags(text: string): string {
  if (!text) return '';
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trimStart();
  if (!stripped && /<think>[\s\S]*?<\/think>/i.test(text)) {
    return '[model final message contained only <think>...</think> reasoning, no plain-text answer]';
  }
  return stripped;
}

export interface OpenAIRunnerOptions {
  client: OpenAI;
  providerConfig: ProviderConfig;
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' };
}

export async function runOpenAI(
  prompt: string,
  options: RunOptions,
  runner: OpenAIRunnerOptions,
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? runner.providerConfig.maxTurns ?? runner.defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? runner.providerConfig.timeoutMs ?? runner.defaults.timeoutMs;
  const toolMode = options.tools ?? runner.defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? runner.providerConfig.effort;

  const sandboxPolicy = options.sandboxPolicy ?? runner.providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  const tracker = new FileTracker();
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);
  const fileTools = toolMode === 'full' ? createOpenAITools(toolImpls, sandboxPolicy) : [];

  // Add hosted tools (web_search, image_generation, etc.) if configured — only when tools are enabled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hostedTools = toolMode === 'full'
    ? (runner.providerConfig.hostedTools ?? []).map(t => ({ type: t } as any))
    : [];
  const tools = [...fileTools, ...hostedTools];

  const model = new OpenAIChatCompletionsModel(runner.client as any, runner.providerConfig.model);

  const agent = new Agent({
    name: 'sub-agent',
    model,
    instructions:
      'You are a sub-agent completing a single task. When you believe the task is complete, ' +
      'respond with your complete answer as plain text — this final message IS the deliverable, ' +
      'and only your last assistant message is captured. Intermediate tool outputs are discarded. ' +
      'Prefer grep and glob over reading whole files, and batch your investigation when possible. ' +
      'Your final answer must be plain text outside any <think> reasoning tags.',
    tools,
    ...(effort && effort !== 'none' && {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelSettings: { reasoning: { effort: effort as any } },
    }),
  });

  const run = async (): Promise<RunResult> => {
    try {
      const result = await agentRun(agent, prompt, { maxTurns, signal: abortController.signal });
      const usage = result.state.usage;
      const filesRead = tracker.getReads();
      const filesWritten = tracker.getWrites();

      // The @openai/agents SDK terminates the loop the moment the model
      // emits an assistant message with no tool calls. The runner used to
      // unconditionally return that message as `output: ok`, even when the
      // message was empty (model produced nothing) or pure reasoning that
      // stripThinkingTags reduced to nothing. The caller then saw an empty
      // success and had to guess what happened.
      //
      // Detect that case and return an explicit `incomplete` status with a
      // diagnostic the caller can read directly.
      const stripped = stripThinkingTags(result.finalOutput ?? '');
      if (stripped.length === 0) {
        return {
          output: buildIncompleteDiagnostic({
            providerLabel: 'openai-compatible',
            turns: usage.requests,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            filesRead,
            filesWritten,
          }),
          status: 'incomplete',
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            costUSD: null,
          },
          turns: usage.requests,
          filesRead,
          filesWritten,
        };
      }

      return {
        output: stripped,
        status: 'ok',
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          costUSD: null,
        },
        turns: usage.requests,
        filesRead,
        filesWritten,
      };
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        return {
          output: `Agent exceeded max turns (${maxTurns}).`,
          status: 'max_turns',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: maxTurns,
          filesRead: tracker.getReads(),
          filesWritten: tracker.getWrites(),
        };
      }
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        filesRead: tracker.getReads(),
        filesWritten: tracker.getWrites(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return withTimeout(run(), timeoutMs, () => ({
    output: `Agent timed out after ${timeoutMs}ms.`,
    status: 'timeout',
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: maxTurns,
  }), abortController);
}

/**
 * Synthesise a diagnostic message for runs that completed without producing
 * usable final output. Surfaces enough metadata for the caller to debug:
 * how many turns were spent, what the model burnt token-wise, and what files
 * the worker actually looked at before giving up.
 */
function buildIncompleteDiagnostic(opts: {
  providerLabel: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  filesRead: string[];
  filesWritten: string[];
}): string {
  const lines = [
    `[${opts.providerLabel} sub-agent terminated without producing a final answer]`,
    '',
    'The agent loop ended on a message with no tool calls and no plain-text content. ' +
      'This usually means one of:',
    '  • the model emitted only <think> reasoning, then stopped',
    '  • the model produced a conversational fragment instead of a final answer',
    '  • a tool call was malformed and the SDK treated the response as terminal',
    '',
    `Turns used:    ${opts.turns}`,
    `Input tokens:  ${opts.inputTokens}`,
    `Output tokens: ${opts.outputTokens}`,
    `Files read:    ${opts.filesRead.length}${opts.filesRead.length > 0 ? ` (${formatFileList(opts.filesRead)})` : ''}`,
    `Files written: ${opts.filesWritten.length}${opts.filesWritten.length > 0 ? ` (${formatFileList(opts.filesWritten)})` : ''}`,
    '',
    'Recommended action: re-dispatch with a tighter, more explicit brief, or escalate to a higher-tier provider.',
  ];
  return lines.join('\n');
}

function formatFileList(files: string[]): string {
  const MAX_SHOWN = 10;
  if (files.length <= MAX_SHOWN) return files.join(', ');
  return `${files.slice(0, MAX_SHOWN).join(', ')}, … ${files.length - MAX_SHOWN} more`;
}
