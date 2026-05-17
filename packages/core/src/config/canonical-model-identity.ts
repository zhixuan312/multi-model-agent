// Normalize a ProviderConfig into a stable identity for equality checks used by
// fallback/separation logic. Credentials, query strings, default ports, and
// trailing slashes are stripped so two configs that point at the same provider
// compare equal. `escalation/fallback.ts` treats failures here as fail-closed
// (catch -> skip) so any malformed config is treated as a non-match rather than
// silently equal.
import type { ProviderConfig } from '../types.js';

export interface CanonicalIdentity {
  providerType: ProviderConfig['type'];
  normalizedEndpoint: string;
  modelId: string;
}

function sanitizeFallback(raw: string): string {
  let s = raw;
  const credIdx = s.indexOf('@');
  if (credIdx !== -1) {
    const protoEnd = s.indexOf('://');
    const start = protoEnd !== -1 ? protoEnd + 3 : 0;
    if (credIdx > start) s = s.slice(0, start) + s.slice(credIdx + 1);
  }
  const queryIdx = s.indexOf('?');
  if (queryIdx !== -1) s = s.slice(0, queryIdx);
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) s = s.slice(0, hashIdx);
  return s.toLowerCase().replace(/\/+$/, '');
}

function normalizeEndpoint(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  let u: URL;
  try { u = new URL(baseUrl); } catch { return sanitizeFallback(baseUrl); }
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function canonicalIdentity(config: ProviderConfig): CanonicalIdentity {
  const baseUrl = (config as { baseUrl?: string }).baseUrl;
  return {
    providerType: config.type,
    normalizedEndpoint: normalizeEndpoint(baseUrl),
    modelId: (config.model ?? '').toLowerCase().trim(),
  };
}

export function identityEquals(a: CanonicalIdentity, b: CanonicalIdentity): boolean {
  return a.providerType === b.providerType
      && a.normalizedEndpoint === b.normalizedEndpoint
      && a.modelId === b.modelId;
}
