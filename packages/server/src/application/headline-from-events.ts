import type { EnvelopeBus, BusMessage } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';

/**
 * Derived from the bus message union rather than imported directly: `plain-log-entry` is not in
 * core's export map, and widening that map for a type this module only reads would be a public
 * API change in service of an internal detail.
 */
type PlainLogEntry = Extract<BusMessage, { type: 'plain' }>['entry'];

/**
 * Turn provider activity into the one human-readable progress line the running snapshot
 * exposes as `runningHeadline`.
 *
 * That field has been readable on both wires since Flow 1 and has never once been populated —
 * `TaskRegistry.setHeadline` had zero production callers — so every consumer, including the
 * Claude Desktop execution monitor, has only ever shown a phase name and a clock. A task
 * spends minutes in `implementing`, during which "implementing" says nothing about whether it
 * is reading files, running tests, or stuck.
 *
 * Both runners are covered deliberately. Codex and Claude emit different event names for the
 * same underlying activity, and a headline that only worked on one of them would look like an
 * intermittent bug rather than a missing case.
 */

/** Longest headline worth emitting. It is one line in a narrow panel, not a log record. */
const MAX_HEADLINE = 72;

function clip(text: string, max = MAX_HEADLINE): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Reduce a shell command to something a human skims. Worker commands are frequently multi-line
 * `bash -lc` blobs with several chained greps; the first meaningful token is the signal and the
 * rest is noise at this width.
 */
function describeCommand(raw: string): string | null {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  // Strip the `/bin/bash -lc "…"` wrapper the codex runner adds, and any leading quote.
  const unwrapped = flat
    .replace(/^\S*(?:bash|sh|zsh)\s+-\w+\s+/, '')
    .replace(/^["']/, '');
  const firstLine = unwrapped.split(/\\n|\n|&&|;|\|/)[0] ?? unwrapped;
  return clip(firstLine) || null;
}

/**
 * Claude tool inputs arrive as a JSON blob. Dumping it raw produces
 * `Read: {"file_path":"/Users/…` — the punctuation eats the width and the useful part is
 * pushed off the end. Pull out the one field that identifies the target instead.
 */
function describeToolInput(input: string, max: number): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'prompt', 'url']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) {
          // A repo-absolute path is mostly shared prefix at this width; the tail identifies it.
          const compact = value.length > max ? `…${value.slice(-(max - 1))}` : value;
          return clip(compact, max);
        }
      }
      return null;
    } catch {
      // Truncated or non-JSON preview — fall through to the raw form.
    }
  }
  return clip(trimmed, max) || null;
}

/**
 * Map one provider event to a headline, or null when the event says nothing a person would
 * want on screen. Returning null is the common case and must stay cheap: this runs on every
 * event of every concurrent task.
 */
export function headlineForEvent(fields: Record<string, string | number | boolean | null>): string | null {
  const event = typeof fields['event'] === 'string' ? fields['event'] : null;
  if (!event) return null;

  switch (event) {
    // ── Tool / command activity: the most informative signal, on both runners ──
    case 'claude_tool_call': {
      const tool = typeof fields['tool'] === 'string' ? fields['tool'] : null;
      if (!tool) return null;
      const input = typeof fields['input'] === 'string' ? fields['input'] : '';
      const detail = describeToolInput(input, Math.max(12, MAX_HEADLINE - tool.length - 2));
      return detail ? `${tool}: ${detail}` : tool;
    }
    case 'codex_command_started': {
      const command = typeof fields['command'] === 'string' ? fields['command'] : null;
      if (!command) return null;
      const described = describeCommand(command);
      return described ? `Running ${described}` : null;
    }

    // ── Narration: less precise, but it is what the model itself says it is doing ──
    case 'claude_text_emission':
    case 'codex_agent_message': {
      const preview = typeof fields['preview'] === 'string'
        ? fields['preview']
        : typeof fields['text'] === 'string' ? fields['text'] : null;
      if (!preview) return null;
      // Skip the structured report. The final answer is a JSON document that happens to
      // arrive on the narration channel, and a headline reading `{"answer":"EnvelopeBus is…`
      // is worse than showing nothing — it is the result, truncated into gibberish, in the
      // slot reserved for what the worker is DOING.
      if (/^\s*[{[]/.test(preview)) return null;
      // First sentence only — the preview can be a whole paragraph.
      const sentence = preview.split(/(?<=[.!?])\s/)[0] ?? preview;
      const headline = clip(sentence);
      return headline.length >= 8 ? headline : null;
    }

    default:
      return null;
  }
}

/**
 * Extract the task this event belongs to, if any.
 *
 * The field on the BUS is `taskId` (camelCase) — providers tag events via `taskTag()`, and
 * `mapProviderEventToPlainEntry` passes keys through verbatim. The snake_case `task_id` seen in
 * the daemon log is produced by the stderr formatter, which snake-cases every key on the way
 * out. Reading `task_id` here therefore matches nothing, which is exactly the bug this
 * function shipped with: every event was silently dropped while the log appeared to prove the
 * field was present. Both spellings are accepted so a future formatter change cannot
 * reintroduce it.
 */
export function taskIdOfEvent(entry: PlainLogEntry): string | null {
  const value = entry.fields['taskId'] ?? entry.fields['task_id'];
  return typeof value === 'string' && value ? value : null;
}

export interface HeadlineSink {
  setHeadline(taskId: string, headline: string): void;
}

/**
 * Subscribe to the bus and keep each running task's headline current.
 *
 * Returns the unsubscribe function. Failures are swallowed per-event on purpose: a headline is
 * decoration, and an exception raised here would propagate into the bus's subscriber loop and
 * disrupt logging and telemetry for a cosmetic feature.
 */
export function attachHeadlineProducer(bus: EnvelopeBus, sink: HeadlineSink): () => void {
  return bus.subscribe({
    name: 'running-headline',
    receive(msg: BusMessage) {
      if (msg.type !== 'plain') return;
      const entry = msg.entry;
      if (entry.kind !== 'provider_event') return;
      const taskId = taskIdOfEvent(entry);
      if (!taskId) return;
      try {
        const headline = headlineForEvent(entry.fields);
        if (headline) sink.setHeadline(taskId, headline);
      } catch {
        // Decoration must never break the bus.
      }
    },
  });
}
