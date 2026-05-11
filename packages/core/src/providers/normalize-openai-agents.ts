// @openai/agents RunResult → mma TurnResult. Pure function; no side
// effects. The caller measures wall-clock and computes cost.
//
// The shape we inspect is the documented public surface:
//   - run.finalOutput   — string (when default text output)
//   - run.rawResponses  — ModelResponse[] each with `usage`
//   - run.newItems      — RunItem[] including RunToolCallItem with `name`
//                         + `rawItem.arguments` (tool input)
// All access is done via index-signature casts so a minor SDK shape
// change doesn't compile-break this module. The SDK smoke test
// (tests/providers/sdk-smoke.test.ts) catches drift.

import type { RunResult as AgentsRunResult } from '@openai/agents';
import type { TurnResult, TokenUsage } from '../types/run-result.js';

const READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_files']);
const WRITE_TOOLS = new Set(['apply_patch', 'write_file', 'edit_file']);

interface AnyRecord { [k: string]: unknown }

function asRec(x: unknown): AnyRecord {
  return (typeof x === 'object' && x !== null) ? (x as AnyRecord) : {};
}

export function normalizeOpenAIAgentsRun(
  run: AgentsRunResult<unknown, never> | unknown,
  args: {
    durationMs: number;
    costUSD: number;
    guardTerminationReason?: TurnResult['terminationReason'];
  },
): TurnResult {
  const r = asRec(run);
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const toolCallsByName: Record<string, number> = {};

  // Sum usage across rawResponses[].usage. Different SDK minor versions
  // expose `cachedTokens` either inside `inputTokensDetails` (record) or
  // alongside as a top-level key — handle both.
  const rawResponses = Array.isArray(r['rawResponses']) ? (r['rawResponses'] as unknown[]) : [];
  let turns = rawResponses.length;
  for (const resp of rawResponses) {
    const u = asRec(asRec(resp)['usage']);
    usage.inputTokens += Number(u['inputTokens'] ?? 0);
    usage.outputTokens += Number(u['outputTokens'] ?? 0);
    const detailsField = u['inputTokensDetails'];
    if (Array.isArray(detailsField)) {
      for (const d of detailsField) usage.cachedReadTokens += Number(asRec(d)['cachedTokens'] ?? 0);
    } else if (detailsField && typeof detailsField === 'object') {
      usage.cachedReadTokens += Number((detailsField as AnyRecord)['cachedTokens'] ?? 0);
    }
  }
  if (turns === 0) turns = 1;

  // Iterate newItems[] for tool calls. We look for the RunToolCallItem
  // shape: rawItem has `name` + `arguments` (or `parameters`). apply_patch
  // is special: each operation carries its own path.
  const newItems = Array.isArray(r['newItems']) ? (r['newItems'] as unknown[]) : [];
  for (const item of newItems) {
    const it = asRec(item);
    const t = String(it['type'] ?? '');
    if (t !== 'tool_call_item' && t !== 'tool_call' && t !== 'function_call_item') continue;
    const raw = asRec(it['rawItem']);
    const name = String(raw['name'] ?? 'unknown');
    toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
    const argsObj = asRec(raw['arguments'] ?? raw['parameters'] ?? raw['input']);
    if (name === 'apply_patch') {
      const ops = Array.isArray(argsObj['operations']) ? (argsObj['operations'] as unknown[]) : [];
      for (const op of ops) {
        const p = String(asRec(op)['path'] ?? '');
        if (p) filesWritten.add(p);
      }
    } else {
      const p = String(argsObj['path'] ?? argsObj['pattern'] ?? '');
      if (p && READ_TOOLS.has(name)) filesRead.add(p);
      if (p && WRITE_TOOLS.has(name)) filesWritten.add(p);
    }
  }

  const sdkErrorCode = typeof r['errorCode'] === 'string' ? (r['errorCode'] as string) : undefined;
  const sdkTermination: TurnResult['terminationReason'] = sdkErrorCode ? 'error' : 'ok';
  const finalTermination = args.guardTerminationReason ?? sdkTermination;
  const finalOutput = r['finalOutput'];
  const output = typeof finalOutput === 'string'
    ? finalOutput
    : (finalOutput === undefined ? '' : String(finalOutput));

  return {
    output,
    usage,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    toolCallsByName,
    turns,
    durationMs: args.durationMs,
    costUSD: args.costUSD,
    terminationReason: finalTermination,
    ...(sdkErrorCode && finalTermination === 'error' && { errorCode: sdkErrorCode }),
  };
}
