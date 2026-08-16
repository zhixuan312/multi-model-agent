// Claude SDK events → mma TurnResult. Pure function; no side effects.
//
// The caller (claude-session.ts) measures wall-clock around the SDK call
// and computes cost from usage × rate card. This module only translates
// the event stream into the TurnResult shape mma expects.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnResult, TokenUsage } from '../types/run-result.js';
import { classifyClaudeToolCall } from './claude-tool-categories.js';

export function normalizeClaudeTurn(
  events: SDKMessage[],
  args: {
    durationMs: number;
    guardTerminationReason?: TurnResult['terminationReason'];
  },
): TurnResult {
  let outputText = '';
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
  const filesWritten = new Set<string>();
  const toolCalls: { turn: number; tool: string }[] = [];
  let usedShell = false;
  let turns = 0;
  let sdkTermination: TurnResult['terminationReason'] = 'ok';
  let sawResult = false;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

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
          // turns is incremented once per assistant event, AFTER this loop —
          // so `turns + 1` is the 1-based turn this block belongs to.
          toolCalls.push({ turn: turns + 1, tool: name });
        }
      }
      turns += 1;
    } else if (ev.type === 'result') {
      sawResult = true;
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
        sdkTermination = 'error';
        errorCode = 'sdk_execution_error';
        errorMessage = ((ev as { error?: { message?: string } }).error?.message)
          ?? ((ev as { result?: string }).result)
          ?? 'Claude execution failed';
      } else if (subtype === 'error_max_structured_output_retries') {
        sdkTermination = 'error'; errorCode = 'sdk_max_structured_output_retries';
      } else {
        // Unknown non-success subtype (future SDK error variant): never let it
        // pass as ok — an explicit success is the only path to 'ok'.
        sdkTermination = 'error';
        errorCode = `sdk_${subtype}`;
      }
    }
  }

  // 'ok' must be EARNED by an explicit success result. A stream that ended
  // without any `result` event did not complete a turn — the SDK subprocess
  // died, or an Anthropic-compatible proxy rejected the call (e.g. auth) before
  // any result was produced. Reporting 'ok' here is what let a dead tier
  // masquerade as a successful implementer (0 tokens, empty output, status
  // done) while the reviewer fabricated the answer.
  // No `sdkTermination === 'ok'` clause: it is only ever assigned inside the `result` branch,
  // which is the same branch that sets `sawResult`. A condition that cannot be false where it
  // is tested reads as if some other path could set it.
  if (!sawResult && !args.guardTerminationReason) {
    sdkTermination = 'error';
    errorCode = 'sdk_no_result';
    errorMessage = 'SDK stream ended without a result event; the provider may be unreachable or rejecting requests';
  }

  // The same doctrine, applied to a result event that CLAIMS success. When the endpoint refuses
  // the connection the SDK still emits `subtype: 'success'`, with the connection error as its
  // `result` text and every usage counter at zero. Trusting that subtype hands the caller a
  // `done_with_concerns` task whose answer is "API Error: Unable to connect to API". Zero billed
  // tokens is the property that gives it away: no model produced anything, so no turn happened.
  // Keyed on the billing, never on the error wording, which changes per provider and per locale.
  const billed = usage.inputTokens + usage.outputTokens + usage.cachedReadTokens + usage.cachedNonReadTokens;
  if (sdkTermination === 'ok' && billed === 0 && !args.guardTerminationReason) {
    sdkTermination = 'error';
    errorCode = 'sdk_no_work_billed';
    errorMessage = outputText
      ? `Provider reported success but billed no tokens; the turn did no work: ${outputText.slice(0, 500)}`
      : 'Provider reported success but billed no tokens; the turn did no work';
  }

  const finalTermination = args.guardTerminationReason ?? sdkTermination;
  return {
    output: outputText,
    usage,
    filesWritten: [...filesWritten],
    usedShell,
    toolCalls,
    // Overwritten by claude-session.ts with the hook's tally. The normalizer is
    // a pure translation of the SDK stream and cannot see hook decisions.
    sandboxDenialCount: 0,
    turns,
    durationMs: args.durationMs,
    // Priced by the caller, which is where the rate card is resolved. This took a `costUSD`
    // argument that every caller passed as 0 and the one production caller then overwrote.
    costUSD: 0,
    terminationReason: finalTermination,
    ...(errorCode && { errorCode }),
    ...(errorMessage && { errorMessage }),
  };
}
