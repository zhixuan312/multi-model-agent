export type ConsentDecision =
  | { enabled: true;  source: 'env' | 'config' | 'default' }
  | { enabled: false; source: 'env' | 'config' | 'config_unreadable' | 'env_invalid' | 'default' };

export interface ConsentInputs {
  env:    string | undefined;     // raw value of MMAGENT_TELEMETRY (undefined if unset, '' if set-empty)
  config: { enabled: boolean } | { kind: 'unreadable' } | undefined;
}

const TRUTHY  = new Set(['1', 'true', 'on', 'yes']);
const FALSY   = new Set(['0', 'false', 'off', 'no']);

export function decideConsent({ env, config }: ConsentInputs): ConsentDecision {
  // env handling per spec §7.1:
  //   - undefined         → fall through to config (env not set)
  //   - '' or whitespace  → fall through to config (set-but-empty: spec says
  //                         "unset or empty string → fall through")
  //   - recognized value  → decide here
  //   - unrecognized      → fail-closed disabled
  // The CLI `mmagent telemetry status` (Phase 7) surfaces the distinction by
  // also reading the env directly and reporting "MMAGENT_TELEMETRY is set to ''
  // (no effect — falls through to config)" when applicable, so users don't
  // mistake the fall-through for a silent-disable.
  if (env !== undefined) {
    const v = env.toLowerCase().trim();
    if (v.length > 0) {
      if (TRUTHY.has(v)) return { enabled: true,  source: 'env' };
      if (FALSY.has(v))  return { enabled: false, source: 'env' };
      return { enabled: false, source: 'env_invalid' };  // typo guard
    }
  }
  if (config && 'kind' in config && config.kind === 'unreadable') {
    return { enabled: false, source: 'config_unreadable' };
  }
  if (config && 'enabled' in config) {
    return { enabled: config.enabled, source: 'config' };
  }
  return { enabled: false, source: 'default' };  // 3.6.0 internal-testing default
}
