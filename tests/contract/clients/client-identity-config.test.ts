import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CLIENT_IDS } from '../../../packages/core/src/clients/client-id.js';
import { parseConfig } from '../../../packages/core/src/config/schema.js';
import { resolveCallerIdentity } from '../../../packages/server/src/http/middleware/caller-identity.js';

const minimalConfig = {
  agents: {
    standard: { type: 'codex', model: 'gpt-test' },
    complex: { type: 'codex', model: 'gpt-test' },
    main: { type: 'codex', model: 'gpt-test' },
  },
  server: {},
  research: {},
};
// Real IncomingMessage, matching tests/http/caller-identity.test.ts's own fakeReq —
// resolveCallerIdentity() reads req.headers, not a hand-shaped object.
function fakeReq(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  for (const [key, value] of Object.entries(headers)) req.headers[key.toLowerCase()] = value;
  return req;
}

describe('contract: canonical client identity', () => {
  it('derives strict partial roster parsing and HTTP attribution from the eight canonical IDs', () => {
    expect(CLIENT_IDS).toEqual([
      'claude-code', 'claude-desktop', 'codex', 'antigravity',
      'cursor', 'vscode', 'opencode', 'windsurf',
    ]);
    expect(parseConfig({ ...minimalConfig, clients: { cursor: 'off' } }).clients).toEqual({ cursor: 'off' });
    expect(parseConfig({ ...minimalConfig, clients: Object.fromEntries(CLIENT_IDS.map((id) => [id, 'on'])) }).clients)
      .toEqual(Object.fromEntries(CLIENT_IDS.map((id) => [id, 'on'])));
    expect(() => parseConfig({ ...minimalConfig, clients: { unknown: 'on' } })).toThrow();
    expect(() => parseConfig({ ...minimalConfig, clients: { cursor: 'suggested' } })).toThrow();
    expect(resolveCallerIdentity(fakeReq({ 'x-mma-client': 'codex' })).callerClient).toBe('codex');
    expect(resolveCallerIdentity(fakeReq({ 'x-mma-client': 'codex-cli' })).callerClient).toBe('other');
    expect(resolveCallerIdentity(fakeReq({ 'x-mma-client': 'gemini-cli' })).callerClient).toBe('other');
  });
});