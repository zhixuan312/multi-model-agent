import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, RegisterBlockPayload } from '../stage-io.js';

const MAX_BYTES = 50 * 1024 * 1024;

export async function registerToBlockStoreHandler(state: LifecycleState): Promise<StageGate<RegisterBlockPayload>> {
  const t0 = Date.now();
  const req = state.request as { content: string } | undefined;
  const bytes = Buffer.byteLength(req?.content ?? '', 'utf-8');

  if (bytes > MAX_BYTES) {
    return {
      outcome: 'halt',
      comment: `payload_too_large: ${bytes} bytes`,
      payload: { blockId: '', bytes },
      telemetry: { stageLabel: 'register-block', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    };
  }

  try {
    // Existing API: pc.contextBlocks.register(content) → RegisteredBlock { id, ... }
    // See packages/core/src/lifecycle/handlers/register-context-block-handlers.ts:13
    // and packages/core/src/stores/context-block-tool.ts:23 for the interface.
    const pc = state.projectContext as any;
    const registered = pc.contextBlocks.register(req?.content ?? '');
    // v4 back-compat: compose_response reads state.blockRegistration to detect
    // the register-context-block route. v5 emits the same data via the gate's
    // payload; we keep this state slot populated for the existing compose path.
    (state as any).blockRegistration = { id: registered.id, size: bytes, ttlMs: pc.contextBlocks.ttlMs };
    return {
      outcome: 'advance',
      payload: { blockId: registered.id, bytes },
      telemetry: { stageLabel: 'register-block', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    };
  } catch (err) {
    return {
      outcome: 'halt',
      comment: `store_write_failed: ${err instanceof Error ? err.message : String(err)}`,
      payload: { blockId: '', bytes },
      telemetry: { stageLabel: 'register-block', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
    };
  }
}