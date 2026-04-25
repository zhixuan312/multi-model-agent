import { homedir } from 'node:os';
import { join } from 'node:path';
import { composeVerboseLine } from '@zhixuan92/multi-model-agent-core/diagnostics/verbose-line';
import { spillRequestBody } from '@zhixuan92/multi-model-agent-core/diagnostics/request-spill';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const INLINE_BODY_LIMIT_BYTES = 16_384;

export interface EmitRequestReceivedInput {
  config: MultiModelConfig;
  batchId: string;
  route: string;
  parsed: unknown;
}

export async function emitRequestReceived(input: EmitRequestReceivedInput): Promise<void> {
  if (!input.config.diagnostics?.verbose) return;

  const json = JSON.stringify(input.parsed);
  const bodyBytes = Buffer.byteLength(json, 'utf8');
  const ts = new Date().toISOString();

  // batch_created is emitted first and owned by the HTTP handler path.
  console.log(composeVerboseLine({ event: 'batch_created', ts, batch: input.batchId }));

  if (bodyBytes <= INLINE_BODY_LIMIT_BYTES) {
    console.log(composeVerboseLine({
      event: 'request_received',
      ts,
      batch: input.batchId,
      route: input.route,
      body: json,
      body_bytes: bodyBytes,
    }));
    return;
  }

  const spillDir = join(homedir(), '.multi-model', 'logs', 'requests');
  const spilled = await spillRequestBody({ dir: spillDir, batch: input.batchId, body: input.parsed });
  console.log(composeVerboseLine({
    event: 'request_received',
    ts,
    batch: input.batchId,
    route: input.route,
    body_path: spilled.path,
    body_bytes: spilled.bytes,
  }));
}
