import { describe, expect, it } from 'vitest';
import { CLIENT_IDS } from '../../../packages/core/src/clients/client-id.js';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { resolveEffectiveRoster } from '../../../packages/server/src/provisioning/roster.js';

describe('contract: client capability roster', () => {
  it('has one valid capability per canonical client and never acts on detection alone', () => {
    expect(CLIENT_CAPABILITIES.map((capability) => capability.id)).toEqual(CLIENT_IDS);
    for (const capability of CLIENT_CAPABILITIES) {
      expect(capability.skillRoot === null).toBe(capability.skillPathStrategy === 'none');
    }
    expect(CLIENT_CAPABILITIES.filter((c) => c.skillRoot === '~/.agents/skills').map((c) => c.id))
      .toEqual(['cursor', 'vscode', 'opencode']);
    const roster = resolveEffectiveRoster({ cursor: 'off', codex: 'on' }, new Set(['cursor', 'vscode']));
    expect(roster.find((row) => row.clientId === 'cursor')?.effectiveState).toBe('off');
    expect(roster.find((row) => row.clientId === 'codex')?.effectiveState).toBe('on');
    expect(roster.find((row) => row.clientId === 'vscode')).toMatchObject({
      declaredState: null, detectedPresence: true, effectiveState: 'suggested',
    });
  });
});