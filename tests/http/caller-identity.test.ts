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

  it('reads X-MMA-Client from headers', () => {
    const req = fakeReq({ 'x-mma-client': 'claude-code' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code', mainModel: null });
  });

  it('normalizes case of header values', () => {
    const req = fakeReq({ 'x-mma-client': 'Claude-Code' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code', mainModel: null });
  });

  it('trims whitespace from header values', () => {
    const req = fakeReq({ 'x-mma-client': '  claude-code  ' });
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'claude-code', mainModel: null });
  });

  it('maps unknown client to "other"', () => {
    const req = fakeReq({ 'x-mma-client': 'unknown-tool' });
    expect(resolveCallerIdentity(req).callerClient).toBe('other');
  });

  it('defaults client to "other" when header missing', () => {
    const req = fakeReq({});
    expect(resolveCallerIdentity(req)).toEqual({ callerClient: 'other', mainModel: null });
  });

  it('reads X-MMA-Main-Model from headers', () => {
    const req = fakeReq({ 'x-mma-main-model': 'claude-opus-4-7' });
    expect(resolveCallerIdentity(req).mainModel).toBe('claude-opus-4-7');
  });

  it('defaults mainModel to null when header missing', () => {
    const req = fakeReq({});
    expect(resolveCallerIdentity(req).mainModel).toBeNull();
  });

  it('treats empty X-MMA-Main-Model as null', () => {
    const req = fakeReq({ 'x-mma-main-model': '   ' });
    expect(resolveCallerIdentity(req).mainModel).toBeNull();
  });

  it('accepts all known clients', () => {
    for (const client of ['claude-code', 'cursor', 'codex-cli', 'gemini-cli']) {
      const req = fakeReq({ 'x-mma-client': client });
      expect(resolveCallerIdentity(req).callerClient).toBe(client);
    }
  });
});
