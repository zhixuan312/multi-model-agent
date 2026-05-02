import { request, Agent } from 'undici';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { ResearchConfig } from '../config/schema.js';
import { wrapFetchedContent } from './untrusted-content.js';
import { resolveAndPin, SsrfBlocked } from './ssrf-guard.js';

export interface WebFetchInput {
  url: string;
  cfg: ResearchConfig['fetch'];
  hostAllowlist: ReadonlySet<string>;
  /** Hosts in this set may resolve to RFC1918 private addresses (still rejects loopback/metadata). */
  privateNetworkHosts?: ReadonlySet<string>;
  /** Test seam — replaces DNS resolution. */
  resolveIP?: (host: string) => Promise<string>;
  /**
   * Test seam — return undefined to let undici use the global dispatcher (so
   * MockAgent intercepts in tests). Default in prod builds an IP-pinning Agent
   * per spec §7.1.10 with TLS SNI on the original hostname.
   *
   * Ownership: dispatchers returned by this hook are caller-owned/shared and
   * will not be closed or destroyed by webFetch. The default dispatcher created
   * by webFetch is one-shot and is disposed after its request completes.
   */
  createDispatcher?: (host: string, pinnedIP: string, cfg: ResearchConfig['fetch']) => import('undici').Dispatcher | undefined;
}

export const defaultIPPinningDispatcher = (host: string, pinnedIP: string, cfg: ResearchConfig['fetch']) =>
  new Agent({
    connect: {
      lookup: (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: 4 | 6) => void) =>
        cb(null, pinnedIP, pinnedIP.includes(':') ? 6 : 4),
      servername: host,
    },
    connectTimeout: cfg.connectTimeoutMs,
  });

export type WebFetchOk = {
  status: 'ok';
  /** Worker-facing string: <external-content …>extracted-text</external-content> */
  body: string;
  /** Adapter-facing raw text (HTML stripped to main-text for HTML; raw bytes for XML/JSON). NOT wrapped. */
  rawText: string;
  host: string;
  bytesReturned: number;
  /** True if the wire-level read was capped by cfg.maxBodyBytes (raw response truncated). */
  truncated: boolean;
  /**
   * True if the post-extraction text was capped by RETURNED_TEXT_CAP (default 64 KiB).
   * Adapters that parse rawText (e.g. rss) MUST inspect this flag — a true value
   * means the XML/JSON body may be syntactically incomplete and parsing should be skipped.
   * This is independent of truncated; both can be true if both caps tripped.
   */
  textTruncated: boolean;
  credentialsStripped: boolean;
};

export type WebFetchErr = {
  status: 'error';
  reasonCode: string;
  host?: string;
  credentialsStripped: boolean;
};

export type WebFetchResult = WebFetchOk | WebFetchErr;

const ALLOWED_CT = new Set([
  'text/html',
  'text/plain',
  'application/xml',
  'application/atom+xml',
  'application/rss+xml',
  'application/json',
]);

/** Post-extraction text cap — default 64 KiB. */
const RETURNED_TEXT_CAP = 64 * 1024;

/** Max bytes to drain from a redirect response body before giving up. */
const REDIRECT_DRAIN_CAP = 64 * 1024;

interface ValidatedURL {
  ok: true;
  url: URL;
  host: string;
  pinnedIP: string;
}

interface ValidationFailed {
  ok: false;
  reasonCode: string;
  host?: string;
}

/**
 * Races a promise against an AbortSignal. If the signal fires first, throws
 * a DOMException with name 'AbortError' so callers can map it to timeout.
 */
async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

async function validateAndPinURL(
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
  // Strip brackets for IPv6 isIP check
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
      throw e; // let caller map to timeout
    }
    if (e instanceof SsrfBlocked) {
      return { ok: false, reasonCode: e.code, host };
    }
    // DNS resolution threw before SsrfBlocked could wrap it (e.g. signals, system errors).
    // resolveAndPin wraps its own resolver errors as web_fetch_dns_resolution_failed,
    // so this path is only reached for truly unexpected failures.
    return { ok: false, reasonCode: 'web_fetch_dns_resolution_failed', host };
  }
  return { ok: true, url, host, pinnedIP };
}

function extractContentType(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['content-type'];
  if (typeof raw === 'string') {
    return raw.split(';')[0]!.trim().toLowerCase();
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return String(raw[0]).split(';')[0]!.trim().toLowerCase();
  }
  return '';
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function extractLocation(headers: Record<string, string | string[] | undefined>): string | null {
  const loc = headers['location'];
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc) && loc.length > 0) return String(loc[0]);
  return null;
}

function extractBodyFromHTML(html: string): string {
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

function stripCredentialsFromURL(url: URL): boolean {
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
async function readBody(
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
async function drainBody(
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

const REDIRECT_ERR_CODE_MAP: Record<string, string> = {
  web_fetch_off_allowlist: 'web_fetch_redirect_off_allowlist',
  web_fetch_invalid_url: 'web_fetch_redirect_invalid_url',
  web_fetch_invalid_scheme: 'web_fetch_redirect_scheme_downgrade',
  web_fetch_ip_literal_blocked: 'web_fetch_redirect_ip_literal_blocked',
  web_fetch_private_ip_blocked: 'web_fetch_redirect_private_ip_blocked',
  web_fetch_reserved_ip_blocked: 'web_fetch_redirect_reserved_ip_blocked',
};

function isUndiciTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT';
}

/** Close/destroy a dispatcher if it supports it (Agent instances do). */
function closeDispatcher(d: import('undici').Dispatcher | undefined): void {
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

function mapRequestError(err: unknown, signal: AbortSignal, host: string): WebFetchErr {
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

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const { cfg, hostAllowlist } = input;
  const privateNetworkHosts = input.privateNetworkHosts ?? new Set<string>();
  let credentialsStripped = false;

  // Strip credentials BEFORE any logging. Mutate to avoid leaking via toString.
  let initial: URL;
  try {
    initial = new URL(input.url);
  } catch {
    return { status: 'error', reasonCode: 'web_fetch_invalid_url', credentialsStripped };
  }
  credentialsStripped = stripCredentialsFromURL(initial);

  // Total-deadline AbortController scopes the entire op (including DNS, redirects, body reads).
  const totalCtrl = new AbortController();
  const totalTimer = setTimeout(() => totalCtrl.abort(), cfg.totalDeadlineMs);

  try {
    let currentURL = initial.toString();
    let redirects = 0;

    while (true) {
      // validateAndPinURL is raced against totalCtrl.signal so a hanging DNS
      // resolver (including injected resolveIP) cannot exceed totalDeadlineMs.
      let v: ValidatedURL | ValidationFailed;
      try {
        v = await validateAndPinURL(
          currentURL,
          hostAllowlist,
          privateNetworkHosts,
          input.resolveIP,
          totalCtrl.signal,
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return { status: 'error', reasonCode: 'web_fetch_timeout', credentialsStripped };
        }
        return { status: 'error', reasonCode: 'web_fetch_dns_resolution_failed', credentialsStripped };
      }

      if (!v.ok) {
        if (redirects > 0) {
          const mapped = REDIRECT_ERR_CODE_MAP[v.reasonCode] ?? v.reasonCode;
          return { status: 'error', reasonCode: mapped, host: v.host, credentialsStripped };
        }
        return { status: 'error', reasonCode: v.reasonCode, host: v.host, credentialsStripped };
      }

      // Build IP-pinning dispatcher. In tests createDispatcher returns undefined
      // so undici falls back to the global dispatcher (MockAgent).
      const usingDefaultDispatcher = input.createDispatcher === undefined;
      const dispatcher = (input.createDispatcher ?? defaultIPPinningDispatcher)(
        v.host,
        v.pinnedIP,
        cfg,
      );

      let res;
      try {
        // undici 8 `request()` does not follow redirects by default; we handle
        // them manually below to re-validate against the per-task allowlist.
        res = await request(v.url.toString(), {
          method: 'GET',
          headersTimeout: cfg.connectTimeoutMs,
          ...(dispatcher ? { dispatcher } : {}),
          signal: totalCtrl.signal,
        });
      } catch (e: unknown) {
        if (usingDefaultDispatcher) closeDispatcher(dispatcher);
        return { ...mapRequestError(e, totalCtrl.signal, v.host), credentialsStripped };
      }

      // Handle redirects manually (maxRedirections: 0 on undici)
      if (isRedirect(res.statusCode)) {
        redirects++;
        if (redirects > cfg.maxRedirects) {
          if (usingDefaultDispatcher) closeDispatcher(dispatcher);
          return { status: 'error', reasonCode: 'web_fetch_too_many_redirects', host: v.host, credentialsStripped };
        }
        const location = extractLocation(res.headers as Record<string, string | string[]>);
        if (!location) {
          if (usingDefaultDispatcher) closeDispatcher(dispatcher);
          return { status: 'error', reasonCode: 'web_fetch_redirect_missing_location', host: v.host, credentialsStripped };
        }

        let nextURL: URL;
        try {
          nextURL = new URL(location, v.url);
        } catch {
          if (usingDefaultDispatcher) closeDispatcher(dispatcher);
          return { status: 'error', reasonCode: 'web_fetch_redirect_invalid_url', host: v.host, credentialsStripped };
        }
        credentialsStripped = stripCredentialsFromURL(nextURL) || credentialsStripped;
        currentURL = nextURL.toString();

        // Drain redirect body with cap to free connection
        await drainBody(res.body as AsyncIterable<unknown> | null, totalCtrl.signal);
        if (usingDefaultDispatcher) closeDispatcher(dispatcher);
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        continue;
      }

      // Check content type. Missing content-type (empty) is allowed through;
      // only explicit unsupported types are rejected.
      const contentType = extractContentType(res.headers as Record<string, string | string[]>);
      if (contentType && !ALLOWED_CT.has(contentType)) {
        await drainBody(res.body as AsyncIterable<unknown> | null, totalCtrl.signal);
        if (usingDefaultDispatcher) closeDispatcher(dispatcher);
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        return { status: 'error', reasonCode: 'web_fetch_unsupported_content_type', host: v.host, credentialsStripped };
      }

      // Read body with size cap. Stream errors map to web_fetch_body_read_failed.
      let rawText: string;
      let bytesReturned: number;
      let truncated: boolean;
      try {
        const rawBody = res.body as AsyncIterable<Uint8Array> | null;
        const result = await readBody(rawBody, cfg.maxBodyBytes, totalCtrl.signal);
        rawText = result.text;
        bytesReturned = result.bytesReturned;
        truncated = result.truncated;
      } catch (e) {
        if (usingDefaultDispatcher) closeDispatcher(dispatcher);
        if (e instanceof DOMException && e.name === 'AbortError') {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        return { status: 'error', reasonCode: 'web_fetch_body_read_failed', host: v.host, credentialsStripped };
      }

      if (usingDefaultDispatcher) closeDispatcher(dispatcher);

      // Extract content for the worker-facing body
      let extracted = rawText;
      if (contentType === 'text/html') {
        extracted = extractBodyFromHTML(rawText);
      }
      // text/plain, application/json, application/xml, application/atom+xml,
      // application/rss+xml all keep rawText as-is for the wrapped body too

      // Apply post-extraction text cap
      let textTruncated = false;
      if (extracted.length > RETURNED_TEXT_CAP) {
        extracted = extracted.slice(0, RETURNED_TEXT_CAP);
        textTruncated = true;
      }

      const wrapped = wrapFetchedContent({
        url: v.url.toString(),
        host: v.host,
        content: extracted,
      });

      return {
        status: 'ok',
        body: wrapped,
        rawText,
        host: v.host,
        bytesReturned,
        truncated,
        textTruncated,
        credentialsStripped,
      };
    }
  } finally {
    clearTimeout(totalTimer);
  }
}
