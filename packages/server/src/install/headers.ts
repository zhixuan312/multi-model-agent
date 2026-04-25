/**
 * Shared outbound header helper for install writers.
 *
 * Returns the `X-MMA-Client` header value identifying which integration
 * (client) is making the outbound request. Used wherever install-writer
 * code POSTs to internal mma routes (e.g. /v1/events).
 *
 * @module
 */

import type { Client } from './manifest.js';

export type HeaderClientName = 'claude-code' | 'cursor' | 'codex-cli' | 'gemini-cli';

export function clientHeaders(client: HeaderClientName) {
  return { 'X-MMA-Client': client };
}

/** Map internal `Client` enum values to the header-friendly client name. */
export function toHeaderClientName(client: Client): HeaderClientName {
  switch (client) {
    case 'claude-code': return 'claude-code';
    case 'cursor':      return 'cursor';
    case 'codex':       return 'codex-cli';
    case 'gemini':      return 'gemini-cli';
  }
}
