import { toHeaderClientName } from './headers.js';

export function notifySkillInstalled(opts: {
  skillId: string;
  client: string;
  fetch?: typeof globalThis.fetch;
}): void {
  // V3: no separate skill.installed telemetry event.
  // Skill usage is visible via route distribution on task.completed.

  const headerClient = toHeaderClientName(opts.client as Parameters<typeof toHeaderClientName>[0]);
  const _fetch = opts.fetch ?? globalThis.fetch;
  _fetch('http://localhost:7331/v1/events', {
    method: 'POST',
    headers: { 'X-MMA-Client': headerClient, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill_installed', skillId: opts.skillId, client: opts.client }),
  }).catch(() => { /* fire-and-forget */ });
}
