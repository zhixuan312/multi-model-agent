// WorkerPidRecorder — bus subscriber persisting the detached codex worker's
// process-group leader pid onto its execution record. Codex workers spawn
// `detached: true` on POSIX (own process group), so they can OUTLIVE a crashed
// daemon; boot reconciliation uses the persisted pid to terminate such
// stragglers before marking the execution interrupted. Claude workers are not
// detached (the SDK subprocess dies with the daemon) and emit no pid — nothing
// to record, nothing to fence.

import type { Subscriber, BusMessage } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import type { ExecutionStore } from './execution-store.js';

export class WorkerPidRecorder implements Subscriber {
  readonly name = 'worker-pid-recorder';

  constructor(private readonly store: ExecutionStore) {}

  receive(msg: BusMessage): void {
    if (msg.type !== 'plain' || msg.entry.kind !== 'provider_event') return;
    const f = msg.entry.fields;
    if (f.event !== 'codex_subprocess_started') return;
    const taskId = f.taskId;
    const pid = f.pid;
    if (typeof taskId !== 'string' || typeof pid !== 'number' || pid <= 0) return;
    this.store.recordWorkerPid(taskId, pid);
  }
}
