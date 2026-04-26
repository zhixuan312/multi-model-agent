import { getRecorder } from '../telemetry/recorder.js';
import { toHeaderClientName } from './headers.js';

export function notifySkillInstalled(opts: {
  skillId: string;
  client: string;
  fetch?: typeof globalThis.fetch;
}): void {
  try {
    getRecorder().recordSkillInstalled(opts.skillId, opts.client);
  } catch { /* silent */ }

  const headerClient = toHeaderClientName(opts.client as Parameters<typeof toHeaderClientName>[0]);
  const _fetch = opts.fetch ?? globalThis.fetch;
  _fetch('http://localhost:7331/v1/events', {
    method: 'POST',
    headers: { 'X-MMA-Client': headerClient, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill_installed', skillId: opts.skillId, client: opts.client }),
  }).catch(() => { /* fire-and-forget — silently ignore errors */ });
}
