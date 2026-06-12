// packages/core/src/events/plain-log-entry.ts
import { z } from 'zod';

export const PlainLogKindEnum = z.enum([
  'server_started','server_stopped',
  'batch_created','request_received','request_spilled',
  'batch_completed','batch_failed',
  'project_evicted',
  'stall_watchdog_armed','stall_watchdog_fired',
  'provider_event',
  'server_error',
]);

const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const PlainLogEntrySchema = z.object({
  ts: z.string().datetime({ offset: true }),
  kind: PlainLogKindEnum,
  fields: z.record(z.string(), FieldValue),
}).strict();
export type PlainLogEntry = z.infer<typeof PlainLogEntrySchema>;

export const PROVIDER_EVENT_NAMES = [
  // Claude (8)
  'claude_session_starting','claude_turn_started','claude_error',
  'claude_turn_completed','claude_text_emission','claude_tool_call','claude_session_closed',
  // Compaction observability (5.1.0, goal mode): emitted on the SDK's
  // compact_boundary system message so long goal-set runs are no longer
  // blind to context compaction. Observe-only — carries {trigger, preTokens, postTokens}.
  'claude_compaction',
  // Codex (13)
  'codex_subprocess_starting','codex_spawn_failed','codex_subprocess_started','codex_subprocess_exited',
  'codex_thread_started','codex_turn_started','codex_command_started','codex_command_completed',
  'codex_turn_completed','codex_turn_failed','codex_error','codex_agent_message','codex_file_change',
] as const;
export type ProviderEventName = (typeof PROVIDER_EVENT_NAMES)[number];

/** Per-event field shapes are NOT pre-declared — `mapProviderEventToPlainEntry`
 *  passes through all primitive fields from the raw event payload (object-valued
 *  fields become `<name>_json`). The names list above is the closed schema; field
 *  shapes are discovered from the provider files at migration time (T11) and
 *  asserted by tests/events/provider-event-mapping.test.ts.
 */

export function mapProviderEventToPlainEntry(
  provider: 'claude' | 'codex',
  event: ProviderEventName,
  rawFields: Record<string, unknown>,
): PlainLogEntry {
  const fields: Record<string, string | number | boolean | null> = { provider, event };
  for (const [k, v] of Object.entries(rawFields)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[k] = v;
    } else {
      fields[`${k}_json`] = JSON.stringify(v);
    }
  }
  return { ts: new Date().toISOString(), kind: 'provider_event', fields };
}
