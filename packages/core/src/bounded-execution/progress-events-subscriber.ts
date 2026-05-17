import type { EventEmitter } from '../events/event-emitter.js';
import type { ActivityTracker } from './activity-tracker.js';

/**
 * Bridges runner-emitted bus events to ActivityTracker progress counters
 * so the per-task polling headline updates live during a stage instead
 * of jumping from 0/0/0 to the final value only at stage transition.
 *
 * Pattern mirrors stall-watchdog.ts:
 *   - Listens on EventEmitter for runner progress events.
 *   - Filters by batchId + taskIndex (bus is process-wide; without filter
 *     every task's events would increment every other task's counters).
 *   - Calls tracker.recordFileRead / recordFileWrite / recordToolCall /
 *     markEvent based on event name.
 *   - Returns a disposer; the caller MUST invoke it in a finally{} so the
 *     subscription is released on the success path too.
 *
 * Event → tracker mapping:
 *   claude_tool_call (Read tool)     → recordFileRead + recordToolCall + markEvent('tool')
 *   claude_tool_call (Write/Edit)    → recordFileWrite + recordToolCall + markEvent('tool')
 *   claude_tool_call (other)         → recordToolCall + markEvent('tool')
 *   codex_command_completed          → recordToolCall + markEvent('tool')
 *   codex_file_change                → recordFileWrite + markEvent('tool')
 *   claude_text_emission             → markEvent('text')
 *   codex_agent_message              → markEvent('text')
 *   claude_turn_started              → markEvent('llm')
 *   codex_turn_started               → markEvent('llm')
 *
 * NOTE: file-read events are not emitted by the codex runner (codex's shell
 * tool doesn't distinguish read vs write at the event layer). We only
 * recognize the explicit claude_tool_call(Read) signal. This is a known
 * gap — codex tasks will undercount filesRead in the live headline; the
 * end-of-stage updateProgress() call still snaps to the correct totals.
 */
export interface ProgressEventsSubscriberContext {
  bus: EventEmitter;
  tracker: ActivityTracker;
  batchId?: string;
  taskIndex?: number;
}

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function startProgressEventsSubscriber(
  ctx: ProgressEventsSubscriberContext,
): () => void {
  const handler = (event: Record<string, unknown>) => {
    const eventName = typeof event.event === 'string' ? event.event : '';
    if (!eventName) return;

    // Filter by task identity — same logic as stall-watchdog.ts.
    if (ctx.batchId !== undefined && event['batchId'] !== ctx.batchId) return;
    if (ctx.taskIndex !== undefined && event['taskIndex'] !== ctx.taskIndex) return;

    switch (eventName) {
      case 'claude_tool_call': {
        const tool = typeof event['tool'] === 'string' ? event['tool'] : '';
        ctx.tracker.recordToolCall();
        if (READ_TOOLS.has(tool)) ctx.tracker.recordFileRead();
        else if (WRITE_TOOLS.has(tool)) ctx.tracker.recordFileWrite();
        ctx.tracker.markEvent('tool');
        return;
      }
      case 'codex_command_completed': {
        ctx.tracker.recordToolCall();
        ctx.tracker.markEvent('tool');
        return;
      }
      case 'codex_file_change': {
        ctx.tracker.recordFileWrite();
        ctx.tracker.markEvent('tool');
        return;
      }
      case 'claude_text_emission':
      case 'codex_agent_message': {
        ctx.tracker.markEvent('text');
        return;
      }
      case 'claude_turn_started':
      case 'codex_turn_started': {
        ctx.tracker.markEvent('llm');
        return;
      }
      default:
        return;
    }
  };

  ctx.bus.on(handler);

  return () => {
    ctx.bus.off(handler);
  };
}
