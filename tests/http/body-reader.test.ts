/**
 * `readBody` had no test of its own, and its failure type had one member.
 *
 * Every non-success path therefore reported `too_large`, so a socket error or a client that
 * disconnected mid-upload was answered — and logged — as "Request body exceeds the N-byte limit".
 * A cause the operator did not have is worse than no cause: it sends them to look at payload sizes
 * for a transport fault. The envelope layer removed the same misattribution when it split
 * cancellation out of a flat `error`.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { readBody } from '../../packages/server/src/http/middleware/body-reader.js';

/** A request stream we can drive by hand. */
function fakeReq(): EventEmitter & { asRequest: IncomingMessage } {
  const em = new EventEmitter() as EventEmitter & { asRequest: IncomingMessage };
  em.asRequest = em as unknown as IncomingMessage;
  return em;
}

describe('readBody', () => {
  it('returns the body when it fits', async () => {
    const req = fakeReq();
    const promise = readBody(req.asRequest, 1024);
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.toString()).toBe('hello world');
  });

  it('reports too_large once the cap is passed, and keeps draining', async () => {
    const req = fakeReq();
    const promise = readBody(req.asRequest, 8);
    req.emit('data', Buffer.from('123456789'));
    // Draining after overflow is what lets the caller answer 413 before closing the socket, so
    // further data must not throw or re-settle.
    expect(() => req.emit('data', Buffer.from('more'))).not.toThrow();
    req.emit('end');
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('counts BYTES, not characters, against the cap', async () => {
    // 'é' is two bytes in UTF-8 and one JS character; a cap measured in characters would admit
    // twice the bytes it advertises.
    const req = fakeReq();
    const promise = readBody(req.asRequest, 5);
    req.emit('data', Buffer.from('ééé', 'utf8')); // 6 bytes, 3 characters
    req.emit('end');
    expect(await promise).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports a socket error as read_error, not as an oversized body', async () => {
    const req = fakeReq();
    const promise = readBody(req.asRequest, 1024);
    req.emit('data', Buffer.from('partial'));
    req.emit('error', new Error('ECONNRESET'));
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: 'read_error' });
  });

  it('an error after a completed read does not overwrite the result', async () => {
    const req = fakeReq();
    const promise = readBody(req.asRequest, 1024);
    req.emit('data', Buffer.from('done'));
    req.emit('end');
    req.emit('error', new Error('late'));
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});
