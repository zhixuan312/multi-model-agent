// Thin wrapper that builds the worker prompt for a given route and dispatches
// via the provider's session.

import type { ExecutionContext } from '../lifecycle/lifecycle-context.js';
import type { TaskSpec } from '../types.js';
import type { MultiModelConfig } from '../types.js';

export type WorkerTurnInput = {
  task: TaskSpec;
  config: MultiModelConfig;
  ctx: ExecutionContext;
  route: string;
  /** Optional prompt override (used by rework which passes a rework-specific prompt). */
  promptOverride?: string;
};

export type WorkerTurnResult =
  | { kind: 'ok'; text: string; costUSD: number; turnsUsed: number; stopReason: 'normal' | 'turn_cap' | 'cost_cap' | 'timeout' }
  | { kind: 'transport_error'; message: string }
  | { kind: 'sandbox_violation'; path: string };

const GIT_FORBIDDEN_INSTRUCTION = [
  '\n\nIMPORTANT — Persistence:',
  'Do NOT run any git subcommand that mutates history',
  '(commit, add, push, reset, rebase, merge, cherry-pick, etc.).',
  'The Committing stage handles persistence at the end.',
  '',
  'IMPORTANT — Structured output:',
  'End your response with a JSON-fenced block describing what you did:',
  '```json',
  '{',
  '  "summary": "one-line description",',
  '  "workerSelfAssessment": "done" | "failed",',
  '  "filesChanged": ["path/to/file.ts", ...],',
  '  "findings": [...],  // read routes only',
  '  "citations": [...],',
  '  "criteriaSucceeded": ["criterion-name", ...],',
  '  "criteriaErrors": [{"criterion":"name","error":"msg"}, ...],',
  '  "sourcesUsed": ["url", ...]',
  '}',
  '```',
].join('\n');

export async function runWorkerTurn(input: WorkerTurnInput): Promise<WorkerTurnResult> {
  try {
    const systemPrompt = (input.task as { systemPrompt?: string }).systemPrompt ?? '';
    const userMessage = (input.task as { userMessage?: string }).userMessage ?? '';
    const base = systemPrompt.length > 0 ? `${systemPrompt}\n\n${userMessage}` : userMessage;
    const instruction = base + GIT_FORBIDDEN_INSTRUCTION;

    const prompt = input.promptOverride ?? instruction;
    const session = input.ctx.getSession(input.ctx.assignedTier);
    const turn = await session.send(prompt);

    const typedTurn = turn as { output?: string; costUSD?: number; turns?: number; terminationReason?: string };

    return {
      kind: 'ok',
      text: typedTurn.output ?? '',
      costUSD: typedTurn.costUSD ?? 0,
      turnsUsed: typedTurn.turns ?? 1,
      stopReason: mapStopReason(typedTurn.terminationReason),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/sandbox/i.test(msg)) return { kind: 'sandbox_violation', path: '(unknown)' };
    return { kind: 'transport_error', message: msg };
  }
}

function mapStopReason(r?: string): 'normal' | 'turn_cap' | 'cost_cap' | 'timeout' {
  switch (r) {
    case 'ok': return 'normal';
    case 'cap_exhausted': return 'turn_cap';
    case 'cost_exceeded': return 'cost_cap';
    case 'time_exceeded': return 'timeout';
    default: return 'normal';
  }
}