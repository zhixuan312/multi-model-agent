import { describe, it, expect } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CLIENT_IDS, AGENT_PLUGIN_CLIENT } from '../../packages/core/src/clients/client-id.js';
import { resolveCallerIdentity, DEFAULT_IDENTITY } from '../../packages/server/src/http/middleware/caller-identity.js';

function fakeReq(headers: Record<string, string>): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  for (const [key, value] of Object.entries(headers)) {
    req.headers[key.toLowerCase()] = value;
  }
  return req;
}

describe('resolveCallerIdentity', () => {
  it('returns the exported default identity, which is "other", when no headers are present', () => {
    // Both halves in one case: that the function falls back to DEFAULT_IDENTITY, and what
    // DEFAULT_IDENTITY is. These were two `it`s with the same `fakeReq({})` setup and the same
    // assertion written two ways — a later case, "defaults client to other when header missing",
    // asserted the literal while this one asserted the constant.
    const req = fakeReq({});
    expect(resolveCallerIdentity(req)).toEqual(DEFAULT_IDENTITY);
    expect(DEFAULT_IDENTITY).toEqual({ callerClient: 'other' });
  });

  it('reads X-MMA-Client from headers', () => {
    const req = fakeReq({ 'x-mma-client': 'claude-code' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code' });
  });

  it('normalizes case of header values', () => {
    const req = fakeReq({ 'x-mma-client': 'Claude-Code' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code' });
  });

  it('trims whitespace from header values', () => {
    const req = fakeReq({ 'x-mma-client': '  claude-code  ' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code' });
  });

  it('maps unknown client to "other"', () => {
    const req = fakeReq({ 'x-mma-client': 'unknown-tool' });
    expect(resolveCallerIdentity(req).callerClient).toBe('other');
  });

  // No X-MMA-Main-Model case: the header is no longer read. The cost baseline is
  // the daemon's configured `agents.main` tier, so an inbound model claim has no
  // effect and resolveCallerIdentity reports client attribution only.
  it('ignores a X-MMA-Main-Model header entirely', () => {
    const req = fakeReq({ 'x-mma-client': 'claude-code', 'x-mma-main-model': 'claude-opus-4-7' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code' });
  });

  it('accepts all canonical clients', () => {
    for (const client of CLIENT_IDS) {
      const req = fakeReq({ 'x-mma-client': client });
      expect(resolveCallerIdentity(req).callerClient).toBe(client);
    }
  });

  it('maps retired non-canonical client ids to "other"', () => {
    for (const client of ['codex-cli', 'gemini-cli']) {
      const req = fakeReq({ 'x-mma-client': client });
      expect(resolveCallerIdentity(req).callerClient).toBe('other');
    }
  });

  it('accepts the explicit other attribution', () => {
    const req = fakeReq({ 'x-mma-client': 'other' });
    expect(resolveCallerIdentity(req).callerClient).toBe('other');
  });
  // An Agent Plugins artifact is loaded by many clients and owned by none, so it
  // is not a member of CLIENT_IDS — but it IS a real, distinguishable caller,
  // exactly like `forge`. Collapsing it to `other` would erase the one number
  // that tells us whether the standard is carrying traffic yet.
  it('accepts the agent-plugin artifact as its own identity, not "other"', () => {
    const req = fakeReq({ 'x-mma-client': AGENT_PLUGIN_CLIENT });
    expect(resolveCallerIdentity(req).callerClient).toBe('agent-plugin');
  });
});
