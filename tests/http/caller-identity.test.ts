import { describe, it, expect } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
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
  it('returns default identity when no headers are present', () => {
    const req = fakeReq({});
    expect(resolveCallerIdentity(req)).toEqual(DEFAULT_IDENTITY);
  });

  it('reads X-MMA-Client and X-MMA-Caller-Skill from headers', () => {
    const req = fakeReq({
      'x-mma-client': 'claude-code',
      'x-mma-caller-skill': 'mma-delegate',
    });
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'claude-code',
      callerSkill: 'mma-delegate',
    });
  });

  it('normalizes case of header values', () => {
    const req = fakeReq({
      'x-mma-client': 'Claude-Code',
      'x-mma-caller-skill': 'MMA-Delegate',
    });
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'claude-code',
      callerSkill: 'mma-delegate',
    });
  });

  it('trims whitespace from header values', () => {
    const req = fakeReq({
      'x-mma-client': '  claude-code  ',
      'x-mma-caller-skill': '  mma-delegate  ',
    });
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'claude-code',
      callerSkill: 'mma-delegate',
    });
  });

  it('maps unknown client to "other"', () => {
    const req = fakeReq({ 'x-mma-client': 'unknown-tool' });
    expect(resolveCallerIdentity(req).callerClient).toBe('other');
    expect(resolveCallerIdentity(req).callerSkill).toBe('direct');
  });

  it('maps unknown skill to "other"', () => {
    const req = fakeReq({
      'x-mma-client': 'claude-code',
      'x-mma-caller-skill': 'mma-unknown',
    });
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'claude-code',
      callerSkill: 'other',
    });
  });

  it('defaults skill to "direct" when header is missing', () => {
    const req = fakeReq({ 'x-mma-client': 'cursor' });
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'cursor',
      callerSkill: 'direct',
    });
  });

  it('defaults client to "other" and skill to "direct" when both missing', () => {
    const req = fakeReq({});
    expect(resolveCallerIdentity(req)).toEqual({
      callerClient: 'other',
      callerSkill: 'direct',
    });
  });

  it('accepts all known clients', () => {
    for (const client of ['claude-code', 'cursor', 'codex-cli', 'gemini-cli']) {
      const req = fakeReq({ 'x-mma-client': client });
      expect(resolveCallerIdentity(req).callerClient).toBe(client);
    }
  });

  it('accepts all known skills', () => {
    const known = [
      'mma-delegate', 'mma-audit', 'mma-review', 'mma-verify', 'mma-debug',
      'mma-execute-plan', 'mma-retry', 'mma-investigate',
      'mma-context-blocks', 'mma-clarifications',
    ];
    for (const skill of known) {
      const req = fakeReq({
        'x-mma-client': 'claude-code',
        'x-mma-caller-skill': skill,
      });
      expect(resolveCallerIdentity(req).callerSkill).toBe(skill);
    }
  });
});
