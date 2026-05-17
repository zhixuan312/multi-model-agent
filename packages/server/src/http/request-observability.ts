import type { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import type { LogWriter } from '@zhixuan92/multi-model-agent-core/events/log-writer';

export interface EmitRequestReceivedDeps {
  bus: EnvelopeBus;
  logWriter: LogWriter;
}

export async function emitRequestReceived(
  deps: EmitRequestReceivedDeps,
  batchId: string,
  route: string,
  parsed: unknown
): Promise<void> {
  const json = JSON.stringify(parsed);
  const bodyBytes = Buffer.byteLength(json, 'utf8');
  const ts = new Date().toISOString();

  // Emit batch_created plain entry
  deps.bus.emitPlainEntry({ ts, kind: 'batch_created', fields: { batch_id: batchId, route } });

  // Emit request_received plain entry
  const inline = bodyBytes <= deps.logWriter.inlineBodyLimit();
  const fields: Record<string, string | number | boolean | null> = { batch_id: batchId, route, body_bytes: bodyBytes };
  if (inline) {
    fields.body = json;
  } else {
    const spilled = await deps.logWriter.spillRequestBody({ batchId, body: parsed });
    fields.body_path = spilled.path;
    fields.body_bytes = spilled.bytes;
  }
  deps.bus.emitPlainEntry({ ts, kind: 'request_received', fields });
}
