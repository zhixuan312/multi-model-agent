import { request, Agent } from 'undici';
import type { ResearchConfig } from '../config/schema.js';
import { wrapFetchedContent } from './untrusted-content.js';
import {
  REDIRECT_ERR_CODE_MAP,
  validateAndPinURL,
  extractContentType,
  isRedirect,
  extractLocation,
  extractBodyFromHTML,
  stripCredentialsFromURL,
  readBody,
  drainBody,
  closeDispatcher,
  mapRequestError,
  type ValidatedURL,
  type ValidationFailed,
} from './web-fetch-helpers.js';

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
