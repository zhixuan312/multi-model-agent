import { findModelProfile } from './model-profiles.js';

/** Returns the canonical model-family prefix (e.g. `gpt-5.5`, `deepseek-v4-pro`)
 *  for a raw model identifier. Falls back to the raw string when no profile
 *  matches. This is distinct from `canonicalIdentity` in
 *  `canonical-model-identity.ts`, which operates on full `ProviderConfig`
 *  (type + model + baseURL + apiKey) for identity-level checks. */
export function canonicalModelName(rawModel: string): string {
  const profile = findModelProfile(rawModel);
  return profile.prefix || rawModel;
}
