// Claude SDK events → mma TurnResult. Pure function; no side effects.
//
// The caller (claude-session.ts) measures wall-clock around the SDK call
// and computes cost from usage × rate card. This module only translates
// the event stream into the TurnResult shape mma expects.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnResult, TokenUsage } from '../types/run-result.js';
import { classifyClaudeToolCall, CLAUDE_SHELL_TOOLS } from './claude-tool-categories.js';

export function normalizeClaudeTurn(
  events: SDKMessage[],
  args: {
    durationMs: number;
    costUSD: number;
    guardTerminationReason?: TurnResult['terminationReason'];
    model?: string;
  },
): TurnResult {
  let outputText = '';
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
  const filesWritten = new Set<string>();
  let usedShell = false;
  let turns = 0;
  let sdkTermination: TurnResult['terminationReason'] = 'ok';
  let errorCode: string | undefined;

  for (const ev of events) {
    if (ev.type === 'assistant') {
      const blocks = ((ev.message as unknown) as { content?: Array<{ type: string; [k: string]: unknown }> } | undefined)?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') outputText += (b as { text?: string }).text ?? '';
        if (b.type === 'tool_use') {
          const name = ((b as { name?: string }).name) ?? '';
          const input = (b as { input?: unknown }).input;
          const { writtenPath, isShell } = classifyClaudeToolCall(name, input);
          if (writtenPath) filesWritten.add(writtenPath);
          if (isShell) usedShell = true;
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
        const finalText = (ev as { result?: string }).result;
        if (finalText && !outputText) outputText = finalText;
      } else if (subtype === 'error_max_turns') {
        sdkTermination = 'error'; errorCode = 'sdk_max_turns';
      } else if (subtype === 'error_max_budget_usd') {
        sdkTermination = 'error'; errorCode = 'sdk_max_budget';
      } else if (subtype === 'error_during_execution') {
        sdkTermination = 'error'; errorCode = 'sdk_execution_error';
      } else if (subtype === 'error_max_structured_output_retries') {
        sdkTermination = 'error'; errorCode = 'sdk_max_structured_output_retries';
      }
    }
  }

  const finalTermination = args.guardTerminationReason ?? sdkTermination;
  return {
    output: outputText,
    usage,
    filesWritten: [...filesWritten],
    usedShell,
    turns,
    durationMs: args.durationMs,
    costUSD: args.costUSD,
    terminationReason: finalTermination,
    ...(errorCode && { errorCode }),
  };
}
