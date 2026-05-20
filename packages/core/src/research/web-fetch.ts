// packages/core/src/research/web-fetch.ts
//
// Replaces the previous IP-pinning dispatcher (which failed 100% of real
// requests on Node 25 / undici current) with a connect-callback re-validation
// SSRF guard: undici resolves the host normally; the connect callback compares
// the resolved IP against ssrf-guard's public-IP classification and aborts
// the connection if it's private/loopback/metadata. validateAndPinURL still
// runs first as the pre-request defense.

import { request, Agent } from 'undici';
import type { LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { ResearchConfig } from '../config/schema.js';
import { USER_AGENT } from './user-agent.js';
import { wrapFetchedContent } from './untrusted-content.js';
import { classifyIP } from './ssrf-guard.js';
import {
  REDIRECT_ERR_CODE_MAP, validateAndPinURL, extractContentType, isRedirect,
  extractLocation, extractBodyFromHTML, stripCredentialsFromURL, readBody,
  drainBody, mapRequestError,
  type ValidatedURL, type ValidationFailed,
} from './web-fetch-helpers.js';

export interface WebFetchInput {
  url:                 string;
  cfg:                 ResearchConfig['fetch'];
  hostAllowlist:       ReadonlySet<string>;
  privateNetworkHosts?: ReadonlySet<string>;
  resolveIP?:          (host: string) => Promise<string>;
  /** Test seam — when present, treated as the IP that the connect callback
   *  "resolved" at request time. Production must not pass this. */
  _testConnectResolvedIp?: string;
  /** Test-only injection seam. When set, webFetch uses the returned dispatcher
   *  (or, if it returns undefined, no dispatcher — so undici's global MockAgent
   *  can intercept). Production never sets this: it always uses the connect-guard
   *  agent built in webFetch(). */
  createDispatcher?: (host: string, pinnedIP: string, cfg: ResearchConfig['fetch']) => import('undici').Dispatcher | undefined;
}

export type WebFetchOk = {
  status: 'ok'; body: string; rawText: string; host: string;
  bytesReturned: number; truncated: boolean; textTruncated: boolean;
  credentialsStripped: boolean;
};

export type WebFetchErr = {
  status: 'error'; reasonCode: string; host?: string; credentialsStripped: boolean;
};

export type WebFetchResult = WebFetchOk | WebFetchErr;

const ALLOWED_CT = new Set([
  'text/html', 'text/plain',
  'application/xml', 'application/atom+xml', 'application/rss+xml',
  'application/json',
]);
const RETURNED_TEXT_CAP = 64 * 1024;

/**
 * Build the SSRF-revalidating `connect.lookup` for the guard agent.
 *
 * undici invokes `connect.lookup` with `{ all: true }` and expects the callback
 * to receive an ARRAY of `{ address, family }` entries — NOT the single-result
 * `dns.lookup(host, (err, address, family) => ...)` form. Returning a bare
 * address string makes undici read `addresses[0].address === undefined`, throw
 * `ERR_INVALID_IP_ADDRESS`, and surface as `web_fetch_request_failed`. Every
 * callback path here therefore returns the array form.
 *
 * Typed as `net.LookupFunction` — the exact type undici's `connect.lookup`
 * field accepts. On error paths we pass an empty address array (undici reads
 * `err` first and never consumes the addresses), which keeps the runtime
 * contract while satisfying the callback's required address argument.
 *
 * Exported for unit testing — it locks the undici lookup contract without
 * requiring real network (see tests/research/web-fetch.test.ts).
 */
export function makeConnectGuardLookup(
  allowPrivateNetwork: boolean,
  testResolvedIp: string | undefined,
): LookupFunction {
  return (host, opts, cb) => {
    // If test seam present, return that IP; otherwise let Node resolve.
    if (testResolvedIp) {
      const fam = testResolvedIp.includes(':') ? 6 : 4;
      // Re-validate test IP via ssrf-guard classification.
      if (!allowPrivateNetwork) {
        if (classifyIP(testResolvedIp) !== 'public') {
          cb(new Error('web_fetch_ssrf_postresolve_block') as NodeJS.ErrnoException, []);
          return;
        }
      }
      cb(null, [{ address: testResolvedIp, family: fam }]);
      return;
    }
    // Production path: forward undici's options (which carry `all: true`) to
    // Node's resolver, re-validate EVERY resolved address via the SSRF
    // classifier, then return the array form undici expects.
    import('node:dns').then(({ lookup }) => {
      lookup(host, { ...opts, all: true }, (err, addresses) => {
        if (err) { cb(err, []); return; }
        const list = addresses as LookupAddress[];
        if (!allowPrivateNetwork) {
          for (const a of list) {
            if (classifyIP(a.address) !== 'public') {
              cb(new Error('web_fetch_ssrf_postresolve_block') as NodeJS.ErrnoException, []);
              return;
            }
          }
        }
        cb(null, list);
      });
    }).catch(e => cb(e as NodeJS.ErrnoException, []));
  };
}

/** Build a shared agent that re-validates the resolved IP at connect time. */
function makeConnectGuardAgent(
  allowPrivateNetwork: boolean,
  testResolvedIp: string | undefined,
  connectTimeoutMs: number,
): Agent {
  const lookup = makeConnectGuardLookup(allowPrivateNetwork, testResolvedIp);
  return new Agent({
    connect: { lookup },
    connectTimeout: connectTimeoutMs,
  });
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const { cfg, hostAllowlist } = input;
  const privateNetworkHosts = input.privateNetworkHosts ?? new Set<string>();
  let credentialsStripped = false;

  let initial: URL;
  try { initial = new URL(input.url); }
  catch { return { status: 'error', reasonCode: 'web_fetch_invalid_url', credentialsStripped }; }
  credentialsStripped = stripCredentialsFromURL(initial);

  const totalCtrl = new AbortController();
  const totalTimer = setTimeout(() => totalCtrl.abort(), cfg.totalDeadlineMs);

  try {
    let currentURL = initial.toString();
    let redirects = 0;

    while (true) {
      let v: ValidatedURL | ValidationFailed;
      try {
        v = await validateAndPinURL(
          currentURL, hostAllowlist, privateNetworkHosts,
          input.resolveIP, totalCtrl.signal,
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

      // Honor createDispatcher hook for tests: when present, use whatever it
      // returns (or skip dispatcher entirely if undefined → MockAgent
      // intercepts via global). In production, fall back to the connect-guard
      // agent for post-resolve SSRF re-validation.
      let agent: import('undici').Dispatcher | undefined;
      if (input.createDispatcher !== undefined) {
        agent = input.createDispatcher(v.host, v.pinnedIP, cfg);
      } else {
        agent = makeConnectGuardAgent(
          cfg.allowPrivateNetwork ?? false,
          input._testConnectResolvedIp,
          cfg.connectTimeoutMs,
        );
      }
      const closeAgent = async () => {
        if (agent && typeof (agent as { close?: () => Promise<void> }).close === 'function') {
          try { await (agent as { close: () => Promise<void> }).close(); } catch { /* ignore */ }
        }
      };

      let res;
      try {
        res = await request(v.url.toString(), {
          method: 'GET',
          headersTimeout: cfg.connectTimeoutMs,
          headers: { 'user-agent': USER_AGENT },
          ...(agent ? { dispatcher: agent } : {}),
          signal: totalCtrl.signal,
        });
      } catch (e: unknown) {
        await closeAgent();
        // Map our connect-callback abort to a stable reasonCode.
        const msg = (e as { message?: string })?.message ?? '';
        if (msg.includes('web_fetch_ssrf_postresolve_block')) {
          return { status: 'error', reasonCode: 'web_fetch_ssrf_postresolve_block', host: v.host, credentialsStripped };
        }
        return { ...mapRequestError(e, totalCtrl.signal, v.host), credentialsStripped };
      }

      if (isRedirect(res.statusCode)) {
        redirects++;
        if (redirects > cfg.maxRedirects) {
          await closeAgent();
          return { status: 'error', reasonCode: 'web_fetch_too_many_redirects', host: v.host, credentialsStripped };
        }
        const location = extractLocation(res.headers as Record<string, string | string[]>);
        if (!location) {
          await closeAgent();
          return { status: 'error', reasonCode: 'web_fetch_redirect_missing_location', host: v.host, credentialsStripped };
        }
        let nextURL: URL;
        try { nextURL = new URL(location, v.url); }
        catch { await closeAgent(); return { status: 'error', reasonCode: 'web_fetch_redirect_invalid_url', host: v.host, credentialsStripped }; }
        credentialsStripped = stripCredentialsFromURL(nextURL) || credentialsStripped;
        currentURL = nextURL.toString();
        await drainBody(res.body as AsyncIterable<unknown> | null, totalCtrl.signal);
        await closeAgent();
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        continue;
      }

      const contentType = extractContentType(res.headers as Record<string, string | string[]>);
      if (contentType && !ALLOWED_CT.has(contentType)) {
        await drainBody(res.body as AsyncIterable<unknown> | null, totalCtrl.signal);
        await closeAgent();
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        return { status: 'error', reasonCode: 'web_fetch_unsupported_content_type', host: v.host, credentialsStripped };
      }

      let rawText: string; let bytesReturned: number; let truncated: boolean;
      try {
        const rawBody = res.body as AsyncIterable<Uint8Array> | null;
        const result = await readBody(rawBody, cfg.maxBodyBytes, totalCtrl.signal);
        rawText = result.text; bytesReturned = result.bytesReturned; truncated = result.truncated;
      } catch (e) {
        await closeAgent();
        if (e instanceof DOMException && e.name === 'AbortError') {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        if (totalCtrl.signal.aborted) {
          return { status: 'error', reasonCode: 'web_fetch_timeout', host: v.host, credentialsStripped };
        }
        return { status: 'error', reasonCode: 'web_fetch_body_read_failed', host: v.host, credentialsStripped };
      }
      await closeAgent();

      let extracted = rawText;
      if (contentType === 'text/html') extracted = extractBodyFromHTML(rawText);

      let textTruncated = false;
      if (extracted.length > RETURNED_TEXT_CAP) {
        extracted = extracted.slice(0, RETURNED_TEXT_CAP);
        textTruncated = true;
      }

      const wrapped = wrapFetchedContent({
        url: v.url.toString(), host: v.host, content: extracted,
      });
      return {
        status: 'ok', body: wrapped, rawText, host: v.host,
        bytesReturned, truncated, textTruncated, credentialsStripped,
      };
    }
  } finally {
    clearTimeout(totalTimer);
  }
}
