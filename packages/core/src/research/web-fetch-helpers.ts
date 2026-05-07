import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { ResearchConfig } from '../config/schema.js';
import { resolveAndPin, SsrfBlocked } from './ssrf-guard.js';
import type { WebFetchInput, WebFetchErr } from './web-fetch.js';

/** Max bytes to drain from a redirect response body before giving up. */
export const REDIRECT_DRAIN_CAP = 64 * 1024;

export const REDIRECT_ERR_CODE_MAP: Record<string, string> = {
  web_fetch_off_allowlist: 'web_fetch_redirect_off_allowlist',
  web_fetch_invalid_url: 'web_fetch_redirect_invalid_url',
  web_fetch_invalid_scheme: 'web_fetch_redirect_scheme_downgrade',
  web_fetch_ip_literal_blocked: 'web_fetch_redirect_ip_literal_blocked',
  web_fetch_private_ip_blocked: 'web_fetch_redirect_private_ip_blocked',
  web_fetch_reserved_ip_blocked: 'web_fetch_redirect_reserved_ip_blocked',
};

export interface ValidatedURL {
  ok: true;
  url: URL;
  host: string;
  pinnedIP: string;
}

export interface ValidationFailed {
  ok: false;
  reasonCode: string;
  host?: string;
}

/**
 * Races a promise against an AbortSignal. If the signal fires first, throws
 * a DOMException with name 'AbortError' so callers can map it to timeout.
 */
export async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export async function validateAndPinURL(
  raw: string,
  hostAllowlist: ReadonlySet<string>,
  privateNetworkHosts: ReadonlySet<string>,
  resolveIP: WebFetchInput['resolveIP'],
  signal: AbortSignal,
): Promise<ValidatedURL | ValidationFailed> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reasonCode: 'web_fetch_invalid_url' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reasonCode: 'web_fetch_invalid_scheme' };
  }
  const stripped = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(stripped) !== 0) {
    return { ok: false, reasonCode: 'web_fetch_ip_literal_blocked' };
  }
  const host = url.hostname.toLowerCase();
  if (!hostAllowlist.has(host)) {
    return { ok: false, reasonCode: 'web_fetch_off_allowlist', host };
  }
  const allowPrivate = privateNetworkHosts.has(host);
  let pinnedIP: string;
  try {
    pinnedIP = await withDeadline(
      resolveAndPin(host, {
        resolve: resolveIP ? async (h) => [await resolveIP(h)] : undefined,
        allowPrivateForHost: allowPrivate,
      }),
      signal,
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    if (e instanceof SsrfBlocked) {
      return { ok: false, reasonCode: e.code, host };
    }
    return { ok: false, reasonCode: 'web_fetch_dns_resolution_failed', host };
  }
  return { ok: true, url, host, pinnedIP };
}

export function extractContentType(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['content-type'];
  if (typeof raw === 'string') {
    return raw.split(';')[0]!.trim().toLowerCase();
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return String(raw[0]).split(';')[0]!.trim().toLowerCase();
  }
  return '';
}

export function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function extractLocation(headers: Record<string, string | string[] | undefined>): string | null {
  const loc = headers['location'];
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc) && loc.length > 0) return String(loc[0]);
  return null;
}

export function extractBodyFromHTML(html: string): string {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html, { url: 'https://localhost/' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.textContent) {
      return article.textContent;
    }
    return dom.window.document.body?.textContent?.trim() ?? html;
  } catch {
    try {
      return dom?.window.document.body?.textContent?.trim() || html;
    } catch {
      return html;
    }
  }
}

export function stripCredentialsFromURL(url: URL): boolean {
  if (!url.username && !url.password) return false;
  url.username = '';
  url.password = '';
  return true;
}

/**
 * Read a response body with a byte cap and abort-signal awareness.
 * Stream errors (non-abort) are re-thrown so the caller can map them to
 * web_fetch_body_read_failed rather than silently returning partial content.
 */
export async function readBody(
  body: AsyncIterable<Uint8Array | string> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; bytesReturned: number; truncated: boolean }> {
  if (!body) return { text: '', bytesReturned: 0, truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of body) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (value.length > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  const decoder = new TextDecoder();
  let text = '';
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { text, bytesReturned: total, truncated };
}

/**
 * Drain a response body with a size cap and abort-signal awareness.
 * Used for redirect responses and rejected content types.
 */
export async function drainBody(
  body: AsyncIterable<unknown> | null,
  signal: AbortSignal,
): Promise<void> {
  if (!body) return;
  let drained = 0;
  try {
    for await (const chunk of body) {
      if (signal.aborted) break;
      let len = 0;
      if (typeof chunk === 'string') {
        len = Buffer.byteLength(chunk);
      } else if (chunk instanceof Uint8Array) {
        len = chunk.length;
      } else if (Buffer.isBuffer(chunk)) {
        len = chunk.length;
      }
      drained += len;
      if (drained > REDIRECT_DRAIN_CAP) break;
    }
  } catch {
    // drain errors are ignorable
  }
}

export function isUndiciTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT';
}

/** Close/destroy a dispatcher if it supports it (Agent instances do). */
export function closeDispatcher(d: import('undici').Dispatcher | undefined): void {
  if (!d) return;
  try {
    if (typeof (d as { destroy?: () => void }).destroy === 'function') {
      (d as { destroy: () => void }).destroy();
    } else if (typeof (d as { close?: () => Promise<void> }).close === 'function') {
      (d as { close: () => Promise<void> }).close().catch(() => {});
    }
  } catch {
    // best-effort cleanup
  }
}

export function mapRequestError(err: unknown, signal: AbortSignal, host: string): WebFetchErr {
  if (signal.aborted) {
    return { status: 'error', reasonCode: 'web_fetch_timeout', host, credentialsStripped: false };
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { status: 'error', reasonCode: 'web_fetch_timeout', host, credentialsStripped: false };
  }
  if (isUndiciTimeout(err)) {
    return { status: 'error', reasonCode: 'web_fetch_timeout', host, credentialsStripped: false };
  }
  return { status: 'error', reasonCode: 'web_fetch_request_failed', host, credentialsStripped: false };
}

// Used by ResearchConfig['fetch'] callers (re-exported by web-fetch.ts).
export type _ResearchFetchCfg = ResearchConfig['fetch'];
