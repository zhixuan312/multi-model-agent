import type { Capability, ProviderConfig } from '../types.js';

/**
 * File-oriented capabilities every provider type offers out of the box via
 * our shared tool implementations. Shell and web capabilities are computed
 * separately below because they depend on runtime configuration.
 */
const FILE_CAPABILITIES: Capability[] = ['file_read', 'file_write', 'grep', 'glob'];

/**
 * Returns the capabilities a provider will actually offer at runtime given
 * its current config. Unlike a static "type → capabilities" map, this
 * function is honest about runtime gates:
 *
 * - `shell` only appears when `sandboxPolicy === 'none'`. The default
 *   `'cwd-only'` sandbox disables shell in every runner, so we must not
 *   advertise it to the consumer LLM when the provider will actually
 *   refuse to run shell commands.
 *
 * - For `codex`, `web_search` is auto-enabled unless the user explicitly
 *   set `hostedTools` (including an explicit empty array as opt-out). This
 *   mirrors the codex runner's default.
 *
 * - For `claude`, `web_search` and `web_fetch` are always available when
 *   the task runs with tools enabled, because the claude runner mounts
 *   those Claude Agent SDK built-ins unconditionally in `toolMode === 'full'`.
 *
 * - For `openai-compatible`, only file capabilities are offered by default.
 *   Users opt into `web_search` by adding it to `hostedTools`.
 *
 * Consumers that need runtime enforcement (e.g., checking the effective
 * capability set after a per-task `sandboxPolicy` override) should use
 * `getEffectiveCapabilities` in `src/delegate.ts`.
 */
export function getCapabilities(config: ProviderConfig): Capability[] {
  const caps: Capability[] = [...FILE_CAPABILITIES];

  // Shell is gated by sandbox policy. Default policy ('cwd-only' when
  // undefined) blocks shell in every runner, so we hide it from the matrix
  // unless the provider is explicitly configured to allow it.
  if (config.sandboxPolicy === 'none') {
    caps.push('shell');
  }

  // Web capabilities differ by provider type.
  switch (config.type) {
    case 'codex': {
      // Codex runner auto-enables web_search when hostedTools is undefined.
      // Explicit empty array or explicit list without 'web_search' opts out.
      const hosted = config.hostedTools ?? ['web_search'];
      if (hosted.includes('web_search')) caps.push('web_search');
      break;
    }
    case 'claude': {
      // Claude runner mounts WebSearch and WebFetch unconditionally when
      // toolMode === 'full'.
      caps.push('web_search', 'web_fetch');
      break;
    }
    case 'openai-compatible': {
      // Only whatever the user explicitly lists in hostedTools is honored.
      if ((config.hostedTools ?? []).includes('web_search')) caps.push('web_search');
      break;
    }
  }

  return Array.from(new Set(caps));
}
