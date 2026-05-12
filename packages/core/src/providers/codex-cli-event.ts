// Codex CLI JSONL event parser. The codex CLI emits one JSON object per
// line on stdout when launched with `--json`. This module is the single
// source of truth for what those events look like and how to parse them.
//
// Pure — no I/O, no logging. Unit-tested via fixture lines captured from
// live `codex exec --json` runs (see tests/providers/codex-cli-event.test.ts).

export interface CodexItem {
  id?: string;
  type?: 'agent_message' | 'command_execution' | 'file_change' | string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: 'in_progress' | 'completed' | string;
  path?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export type CodexCliEvent =
  | { kind: 'thread_started'; threadId: string }
  | { kind: 'turn_started' }
  | { kind: 'item_started'; item: CodexItem }
  | { kind: 'item_completed'; item: CodexItem }
  | { kind: 'turn_completed'; usage: CodexUsage }
  | { kind: 'turn_failed'; error: { message: string } }
  | { kind: 'error'; message: string }
  | { kind: 'unparseable'; raw: string };

export function parseCodexCliEvent(line: string): CodexCliEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try { obj = JSON.parse(trimmed); } catch { return { kind: 'unparseable', raw: trimmed }; }
  if (typeof obj !== 'object' || obj === null || !('type' in obj)) {
    return { kind: 'unparseable', raw: trimmed };
  }

  const o = obj as Record<string, unknown>;
  switch (o.type) {
    case 'thread.started':
      return { kind: 'thread_started', threadId: typeof o.thread_id === 'string' ? o.thread_id : '' };
    case 'turn.started':
      return { kind: 'turn_started' };
    case 'item.started':
      return { kind: 'item_started', item: (o.item ?? {}) as CodexItem };
    case 'item.completed':
      return { kind: 'item_completed', item: (o.item ?? {}) as CodexItem };
    case 'turn.completed':
      return { kind: 'turn_completed', usage: (o.usage ?? {}) as CodexUsage };
    case 'turn.failed': {
      const err = (o.error ?? {}) as { message?: unknown };
      return { kind: 'turn_failed', error: { message: typeof err.message === 'string' ? err.message : '' } };
    }
    case 'error':
      return { kind: 'error', message: typeof o.message === 'string' ? o.message : '' };
    default:
      return { kind: 'unparseable', raw: trimmed };
  }
}
