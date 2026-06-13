import { readFileSync } from 'node:fs';
import { BASE_URL, TOKEN_FILE } from './config.mjs';

const HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'X-MMA-Client': 'claude-code',
  'X-MMA-Main-Model': 'claude-opus-4-7',
  'Content-Type': 'application/json',
});

export function readToken() {
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

export async function dispatch(token, type, body, cwd) {
  const url = type === 'context-blocks'
    ? `${BASE_URL}/context-blocks?cwd=${encodeURIComponent(cwd)}`
    : `${BASE_URL}/task?cwd=${encodeURIComponent(cwd)}`;
  const payload = type === 'context-blocks' ? body : { type, ...body };
  const res = await fetch(url,
    { method: 'POST', headers: HEADERS(token), body: JSON.stringify(payload) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function getTask(token, taskId) {
  const res = await fetch(`${BASE_URL}/task/${taskId}`, { headers: HEADERS(token) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

export async function deleteContextBlock(token, id, cwd) {
  const res = await fetch(`${BASE_URL}/context-blocks/${id}?cwd=${encodeURIComponent(cwd)}`,
    { method: 'DELETE', headers: HEADERS(token) });
  return res.status;
}
