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

export async function dispatch(token, route, body, cwd) {
  const res = await fetch(`${BASE_URL}/${route}?cwd=${encodeURIComponent(cwd)}`,
    { method: 'POST', headers: HEADERS(token), body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function getBatch(token, batchId) {
  const res = await fetch(`${BASE_URL}/batch/${batchId}`, { headers: HEADERS(token) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

// Generic authenticated GET (introspection routes: /status, /__routes).
// /health is auth-exempt — pass auth=false.
export async function get(token, path, auth = true) {
  const headers = auth
    ? { 'Authorization': `Bearer ${token}`, 'X-MMA-Client': 'claude-code', 'X-MMA-Main-Model': 'claude-opus-4-7' }
    : {};
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.text() };
}

export async function deleteContextBlock(token, id, cwd) {
  const res = await fetch(`${BASE_URL}/context-blocks/${id}?cwd=${encodeURIComponent(cwd)}`,
    { method: 'DELETE', headers: HEADERS(token) });
  return res.status;
}
