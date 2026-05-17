// Claude SDK events → mma TurnResult. Pure function; no side effects.
//
// The caller (claude-session.ts) measures wall-clock around the SDK call
// and computes cost from usage × rate card. This module only translates
// the event stream into the TurnResult shape mma expects.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnResult, TokenUsage } from '../types/run-result.js';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export function normalizeClaudeTurn(
  events: SDKMessage[],
  args: {
    durationMs: number;
    /** Cost computed by the caller from usage × rate card. */
    costUSD: number;
    /** When set, overrides any SDK-reported terminal reason. */
    guardTerminationReason?: TurnResult['terminationReason'];
    /** Model ID for this turn. */
    model?: string;
  },
): TurnResult {
  let outputText = '';
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const toolCallsByName: Record<string, number> = {};
  let turns = 0;
  let sdkTermination: TurnResult['terminationReason'] = 'ok';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  for (const ev of events) {
    if (ev.type === 'assistant') {
      const blocks = ((ev.message as unknown) as { content?: Array<{ type: string; [k: string]: unknown }> } | undefined)?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') outputText += (b as { text?: string }).text ?? '';
        if (b.type === 'tool_use') {
          const name = ((b as { name?: string }).name) ?? 'unknown';
          toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
          const input = (b as { input?: { file_path?: string; pattern?: string } }).input;
          const path = input?.file_path ?? input?.pattern;
          if (path && READ_TOOLS.has(name)) filesRead.add(path);
          if (path && WRITE_TOOLS.has(name)) filesWritten.add(path);
        }
      }
      turns += 1;
    } else if (ev.type === 'result') {
      const u = (ev as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
      if (u) {
        usage.inputTokens += u.input_tokens ?? 0;
        usage.outputTokens += u.output_tokens ?? 0;
        usage.cachedReadTokens += u.cache_read_input_tokens ?? 0;
        usage.cachedNonReadTokens += u.cache_creation_input_tokens ?? 0;
      }
      const subtype = (ev as { subtype: string }).subtype;
      if (subtype === 'success') {
        sdkTermination = 'ok';
        // The SDK's `result` field carries the final assistant text for success.
        const finalText = (ev as { result?: string }).result;
        if (finalText && !outputText) outputText = finalText;
      } else if (subtype === 'error_max_turns') {
        sdkTermination = 'error'; errorCode = 'sdk_max_turns';
      } else if (subtype === 'error_max_budget_usd') {
        sdkTermination = 'error'; errorCode = 'sdk_max_budget';
      } else if (subtype === 'error_during_execution') {
        sdkTermination = 'error'; errorCode = 'sdk_execution_error';
        const errs = (ev as { errors?: string[] }).errors;
        if (errs?.length) errorMessage = errs[0];
      } else if (subtype === 'error_max_structured_output_retries') {
        sdkTermination = 'error'; errorCode = 'sdk_max_structured_output_retries';
      }
    }
  }

  const finalTermination = args.guardTerminationReason ?? sdkTermination;
  return {
    output: outputText,
    usage,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    toolCallsByName,
    turns,
    durationMs: args.durationMs,
    costUSD: args.costUSD,
    terminationReason: finalTermination,
    ...(errorCode && { errorCode }),
    ...(errorMessage && { errorMessage }),
    ...(args.model && { model: args.model }),
  };
}
