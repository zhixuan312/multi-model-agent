import type { LifecycleState } from '../stage-plan-types.js';
import type { ProjectContext } from '../../stores/project-context-registry.js';

export function registerToBlockStoreHandler(state: LifecycleState): void {
  if (state.terminal) return;
  const pc = state.projectContext as ProjectContext | undefined;
  const req = state.request as { content: string } | undefined;
  if (!pc || !req?.content) {
    state.terminal = true;
    state.errorCode = 'invalid_request';
    return;
  }
  const registered = pc.contextBlocks.register(req.content);
  state.blockRegistration = {
    id: registered.id,
    size: Buffer.byteLength(req.content, 'utf8'),
    ttlMs: pc.contextBlocks.ttlMs,
  };
}
