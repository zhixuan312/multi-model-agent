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
 */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trimStart();
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
    instructions: 'You are a helpful assistant. Complete the task given to you. Use the provided tools when needed.',
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

      return {
        output: stripThinkingTags(result.finalOutput ?? ''),
        status: 'ok',
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          costUSD: null,
        },
        turns: usage.requests,
        files: tracker.getFiles(),
      };
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        return {
          output: `Agent exceeded max turns (${maxTurns}).`,
          status: 'max_turns',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: maxTurns,
          files: tracker.getFiles(),
        };
      }
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: tracker.getFiles(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return withTimeout(run(), timeoutMs, () => ({
    output: `Agent timed out after ${timeoutMs}ms.`,
    status: 'timeout',
    files: tracker.getFiles(),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: maxTurns,
  }), abortController);
}
