import { readFileSync } from 'node:fs';
import { BASE_URL, TOKEN_FILE } from './config.mjs';

/** The client identity this harness declares on every dispatch. Exported so the
 *  telemetry verifier asserts the SAME value that was sent, rather than a second
 *  hardcoded copy that could drift into agreeing with a bug. */
export const SMOKE_CLIENT = 'claude-code';

// No `X-MMA-Main-Model`: the header was deleted. The cost baseline is the
// daemon's configured `agents.main` tier, which the telemetry verifier asserts
// against `~/.mma/config.json` rather than against anything this harness sends.
const HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'X-MMA-Client': SMOKE_CLIENT,
  'Content-Type': 'application/json',
});

export function readToken() {
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

export async function dispatch(token, type, body, cwd) {
  const url = type === 'context-blocks'
    ? `${BASE_URL}/context-blocks?cwd=${encodeURIComponent(cwd)}`
    : `${BASE_URL}/execution?cwd=${encodeURIComponent(cwd)}`;
  const payload = type === 'context-blocks' ? body : { type, ...body };
  const res = await fetch(url,
    { method: 'POST', headers: HEADERS(token), body: JSON.stringify(payload) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function getTask(token, taskId) {
  const res = await fetch(`${BASE_URL}/execution/${taskId}`, { headers: HEADERS(token) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

/** DELETE /execution/:id — request cooperative cancellation. 202 = requested (the task
 *  keeps running until the runner confirms), 200 = already terminal. */
export async function cancelTask(token, taskId) {
  const res = await fetch(`${BASE_URL}/execution/${taskId}`, { method: 'DELETE', headers: HEADERS(token) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

/** One JSON-RPC call against POST /mcp. The adapter is stateless per request, so
 *  each call carries the protocol headers rather than reusing a session. */
export async function mcpCall(token, method, params, id = 1) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS(token), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  // The transport replies as SSE (`event: message\ndata: {...}`) or bare JSON.
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = dataLine ? dataLine.slice('data: '.length) : text;
  let json = null;
  try { json = JSON.parse(payload); } catch { /* non-JSON body */ }
  return { status: res.status, json, raw: text };
}

export async function deleteContextBlock(token, id, cwd) {
  const res = await fetch(`${BASE_URL}/context-blocks/${id}?cwd=${encodeURIComponent(cwd)}`,
    { method: 'DELETE', headers: HEADERS(token) });
  return res.status;
}
