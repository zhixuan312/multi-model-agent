import { z } from 'zod';
import type { CostTier, ProviderConfig } from '../types.js';
import profileData from '../model-profiles.json' with { type: 'json' };


// ── Vendor prefix normalization ──────────────────────────────────────────

const STRICT_ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9_.:+/@]{0,119}$/;

const SLASH_VENDOR_PREFIXES = [
  'azure/openai/',
  'vertex-ai/',
  'vertex/',
  'openrouter/',
  'together/',
  'groq/',
  'fireworks/',
  'replicate/',
  'ollama/',
  'lmstudio/',
  'vllm/',
  'anyscale/',
  'deepinfra/',
  'octoai/',
  'aws-bedrock/',
  'bedrock/',
  'aws_bedrock/',
  'vertex_ai/',
  'azure_openai/',
  'azureopenai/',
  'gcp/',
  'anthropic/',
  'openai/',
];

const DOT_VENDOR_PREFIXES = [
  'bedrock.',
  'azure.',
  'aws.',
  'gcp.',
  'anthropic.',
  'openai.',
  'vertex.',
];

const DASH_VENDOR_PREFIXES = ['aws-bedrock-', 'bedrock-', 'azure-'];
const TRAILING_MARKERS = [
  /@\d{4}-\d{2}-\d{2}$/i,
  /-\d{4}(?:-\d{2}){0,2}$/i,
  /-v\d+(?::\d+)?$/i,
  /-preview-\d+(?:-\d+)?$/i,
  /-preview$/i,
  /-latest$/i,
  /-\d+k?$/i,
  /-base$/i,
  /-instruct$/i,
  /-chat$/i,
  /-it$/i,
];

/**
 * Strip well-known vendor prefixes (case-insensitive) and Bedrock-style
 * version suffixes to recover the canonical model identifier.
 *
 * Prefix stripping repeats until no prefix matches so compound prefixes
 * like `vertex_ai/anthropic.` collapse correctly.
 *
 * Idempotent: repeated application returns the same result.
 * Bare model names pass through unchanged.
 */
/**
 * Returns the canonical wire-display model name for telemetry.
 *
 * v4.0.3+: preserves the model + version (e.g. `claude-opus-4-7` instead
 * of collapsing to the prefix `claude-opus`). Strategy:
 *   1. Strip vendor namespace prefixes (`vertex_ai/anthropic.`, `aws-bedrock-`).
 *   2. If the result starts with a known profile prefix → return the
 *      namespace-stripped form WITH date/release-tag suffixes removed,
 *      preserving model + version.
 *   3. If only the trailing-marker-stripped form matches a prefix → return
 *      the trailing-marker-stripped form (date suffix gone, version may
 *      have been part of the trailing marker).
 *   4. No prefix match → 'custom'.
 *
 * Date-only suffix stripping uses DATE_TRAILING_MARKERS (YYYY-MM-DD,
 * @timestamps, -latest) — NOT the broader TRAILING_MARKERS that strip
 * version digits. Family resolution still uses prefix collapsing via
 * `findModelProfile` — this function feeds the wire `mainModel` /
 * `implementerModel` slots that downstream cost analysis groups by.
 */
const DATE_TRAILING_MARKERS = [
  /@\d{4}-\d{2}-\d{2}$/i,   // claude-opus-4-1@2025-07-15
  /-\d{4}-\d{2}-\d{2}$/i,   // claude-3-opus-2024-02-29 (long form)
  /-\d{8}$/,                // claude-3-opus-20240229 (compact)
  /-latest$/i,
];

function stripDateMarkers(raw: string): string {
  let result = raw;
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of DATE_TRAILING_MARKERS) {
      const next = result.replace(marker, '');
      if (next !== result) {
        result = next;
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** Truncate at the first token-boundary character that's not part of a
 *  model id (`_`, `:`, ` `, `@`, `/`). These mark the start of an
 *  out-of-band wrapper suffix the user didn't intend as part of the
 *  model name. Preserves `-` and `.` since those ARE part of standard
 *  model id syntax (claude-opus-4-7, gpt-5.5). */
function truncateAtWrapperBoundary(form: string): string {
  const boundary = form.search(/[_: @\/]/);
  return boundary === -1 ? form : form.slice(0, boundary);
}

/** Strip random-suffix junk that survived prior cleaning passes. Real
 *  wire data sometimes carries trailing tokens that aren't proper
 *  release tags (e.g., `claude-sonnet-4-6-suffix`). Heuristic: if the
 *  trailing dash-segment is a known model-noise word, strip it. */
const TRAILING_NOISE_WORDS = new Set([
  'suffix', 'junk', 'tag', 'rev', 'build', 'release',
]);
function stripTrailingNoise(form: string): string {
  const lastDash = form.lastIndexOf('-');
  if (lastDash === -1) return form;
  const tail = form.slice(lastDash + 1).toLowerCase();
  return TRAILING_NOISE_WORDS.has(tail) ? form.slice(0, lastDash) : form;
}

/** Strip provisioning-version markers like `-v1`, `-v2` (AWS Bedrock,
 *  Vertex). Distinct from the model's semantic version (`claude-opus-4-7`)
 *  — `-v1` is a deployment artifact, not part of the canonical id. We
 *  can't use the broader TRAILING_MARKERS list here because that strips
 *  trailing digit segments like `-7` which IS part of the model name. */
const PROVISIONING_VERSION_MARKER = /-v\d+$/i;
function stripProvisioningVersion(form: string): string {
  return form.replace(PROVISIONING_VERSION_MARKER, '');
}

/** Run the full clean pipeline on a candidate form. Each step strips
 *  one class of noise; we run boundary truncation EVERY pass because
 *  any prior step may have exposed new wrapper junk. */
function cleanCandidate(form: string): string {
  let result = stripLeadingNamespace(form);
  result = truncateAtWrapperBoundary(result);
  result = stripDateMarkers(result);
  result = stripProvisioningVersion(result);
  result = stripTrailingNoise(result);
  return result;
}

export function extractCanonicalModelName(raw: string): string {
  if (!STRICT_ID_REGEX.test(raw)) return 'custom';

  // First pass: clean the raw input and check if it starts with a known
  // profile prefix. Covers the common case (`claude-opus-4-7`,
  // `bedrock.claude-opus-4-7`, `vertex_ai/anthropic.claude-sonnet-4-5`).
  const cleaned = cleanCandidate(raw);
  if (longestPrefixCanonical(cleaned)) return cleaned;

  // Fallback A: aggressive trailing-marker stripping (release tags etc.)
  const fullyStripped = stripTrailingMarkers(cleaned);
  if (longestPrefixCanonical(fullyStripped)) return fullyStripped;

  // Fallback B: best-effort substring extraction for ids embedded in
  // arbitrary wrappers (`my_router_42_claude-opus-4-7_xyz`,
  // `proxy:claude-opus-4-7@v3`). Find the longest known profile prefix
  // appearing anywhere in the raw input, slice from that position, and
  // re-clean. This covers wire data from custom routers / proxies that
  // sandwich the canonical id between random tokens.
  const substringMatch = longestPrefixSubstring(raw);
  if (substringMatch !== null) {
    const cleanedSlice = cleanCandidate(raw.slice(substringMatch.startIndex));
    if (cleanedSlice.length > 0 && longestPrefixCanonical(cleanedSlice)) {
      return cleanedSlice;
    }
  }

  return 'custom';
}

/** Search `candidate` for any known profile prefix appearing as a
 *  substring (case-insensitive). Returns the start index of the longest
 *  match, or null if none found. Used by the best-effort fallback in
 *  extractCanonicalModelName so model ids embedded in arbitrary
 *  wrappers still resolve to a canonical slice. */
function longestPrefixSubstring(candidate: string): { startIndex: number; prefix: string } | null {
  const normalized = candidate.toLowerCase();
  let best: { startIndex: number; prefix: string } | null = null;
  for (const entry of PROFILE_ENTRIES) {
    const idx = normalized.indexOf(entry.prefix.toLowerCase());
    if (idx === -1) continue;
    if (!best || entry.prefix.length > best.prefix.length) {
      best = { startIndex: idx, prefix: entry.prefix };
    }
  }
  return best;
}

const tierSchema = z.enum(['trivial', 'standard', 'reasoning']);
const costTierSchema = z.enum(['free', 'low', 'medium', 'high']);
export const ModelFamilyEnum = z.enum([
  'claude',
  'openai',
  'gemini',
  'deepseek',
  'llama',
  'mistral',
  'qwen',
  'grok',
  'cohere',
  'phi',
  'gemma',
  'yi',
  'kimi',
  'sonar',
  'nova',
  'glm',
  'minimax',
  'jamba',
  'granite',
  'nemotron',
  'dbrx',
  'arctic',
  'reka',
  'olmo',
  'hermes',
  'wizardlm',
  'starcoder',
  'dolphin',
  'openchat',
  'vicuna',
  'internlm',
  'baichuan',
  'other',
] as const);
export type ModelFamily = z.infer<typeof ModelFamilyEnum>;

export const modelProfileSchema = z.object({
  prefix: z.string().min(1),
  family: ModelFamilyEnum,
  tier: tierSchema,
  defaultCost: costTierSchema,
  bestFor: z.string().min(1),
  avoidFor: z.string().optional(),
  notes: z.string().optional(),
  supportsEffort: z.boolean(),
  inputCostPerMTok: z.number().finite().nonnegative().optional(),
  outputCostPerMTok: z.number().finite().nonnegative().optional(),
  cachedReadCostPerMTok:     z.number().finite().nonnegative().optional(),
  cachedNonReadCostPerMTok:  z.number().finite().nonnegative().optional(),
  reasoningCostPerMTok: z.number().finite().nonnegative().optional(),
  rateSource: z.string().min(1).optional(),
  rateLookupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Per-model-family default for the watchdog input-token soft limit.
   *  See spec A.1.4. */
  inputTokenSoftLimit: z.number().int().positive(),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

const DEFAULT_PROFILE: ModelProfile = {
  prefix: '',
  family: 'other',
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
  supportsEffort: false,
  inputTokenSoftLimit: 100_000,
};

// === Hierarchical JSON schema (short field names for human readability) ===

const profileEntrySchema = z.object({
  prefix: z.string().min(1),
  family: ModelFamilyEnum.optional(),
  tier: tierSchema.optional(),
  cost: costTierSchema.optional(),           // short for defaultCost
  bestFor: z.string().min(1).optional(),
  avoidFor: z.string().optional(),
  notes: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  input: z.number().finite().nonnegative().optional(),   // short for inputCostPerMTok
  output: z.number().finite().nonnegative().optional(),  // short for outputCostPerMTok
  cachedRead:     z.number().finite().nonnegative().optional(),
  cachedNonRead:  z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  inputTokenSoftLimit: z.number().int().positive().optional(),
});

const providerGroupSchema = z.object({
  provider: z.string().min(1),
  naming: z.string().min(1),
  rateSource: z.string().min(1).optional(),
  rateLookupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaults: z.object({
    family: ModelFamilyEnum.optional(),
    supportsEffort: z.boolean(),
    inputTokenSoftLimit: z.number().int().positive(),
  }),
  profiles: z.array(profileEntrySchema).min(1),
});

type ProfileEntry = z.infer<typeof profileEntrySchema>;

/**
 * Find the longest prefix in `resolved` that is a strict prefix of `prefix`.
 * This gives us the parent profile to inherit from.
 */
function findParentProfile(prefix: string, resolved: Map<string, ModelProfile>): ModelProfile | undefined {
  let best: ModelProfile | undefined;
  let bestLen = 0;
  for (const [key, profile] of resolved) {
    if (key.length < prefix.length && prefix.toLowerCase().startsWith(key.toLowerCase()) && key.length > bestLen) {
      best = profile;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Resolve a profile entry by merging: provider defaults → parent profile → entry overrides.
 * Short JSON field names (input/output/cost) are mapped to canonical long names.
 */
function resolveEntry(
  entry: ProfileEntry,
  providerDefaults: { family?: ModelFamily; supportsEffort: boolean; inputTokenSoftLimit: number },
  providerMeta: { rateSource?: string; rateLookupDate?: string },
  resolved: Map<string, ModelProfile>,
): ModelProfile {
  const parent = findParentProfile(entry.prefix, resolved);

  // Start with provider defaults
  const result: ModelProfile = {
    prefix: entry.prefix,
    family: entry.family ?? parent?.family ?? providerDefaults.family ?? 'other',
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'general tasks',
    supportsEffort: providerDefaults.supportsEffort,
    inputTokenSoftLimit: providerDefaults.inputTokenSoftLimit,
    rateSource: providerMeta.rateSource,
    rateLookupDate: providerMeta.rateLookupDate,
  };

  // Layer parent profile
  if (parent) {
    result.tier = parent.tier;
    result.defaultCost = parent.defaultCost;
    result.family = parent.family;
    result.bestFor = parent.bestFor;
    if (parent.avoidFor !== undefined) result.avoidFor = parent.avoidFor;
    result.supportsEffort = parent.supportsEffort;
    if (parent.inputCostPerMTok !== undefined) result.inputCostPerMTok = parent.inputCostPerMTok;
    if (parent.outputCostPerMTok !== undefined) result.outputCostPerMTok = parent.outputCostPerMTok;
    if (parent.cachedReadCostPerMTok     !== undefined) result.cachedReadCostPerMTok     = parent.cachedReadCostPerMTok;
    if (parent.cachedNonReadCostPerMTok !== undefined) result.cachedNonReadCostPerMTok = parent.cachedNonReadCostPerMTok;
    if (parent.reasoningCostPerMTok !== undefined) result.reasoningCostPerMTok = parent.reasoningCostPerMTok;
    result.inputTokenSoftLimit = parent.inputTokenSoftLimit;
  }

  // Layer entry overrides (short names → long names)
  if (entry.tier !== undefined) result.tier = entry.tier;
  if (entry.family !== undefined) result.family = entry.family;
  if (entry.cost !== undefined) result.defaultCost = entry.cost;
  if (entry.bestFor !== undefined) result.bestFor = entry.bestFor;
  if (entry.avoidFor !== undefined) result.avoidFor = entry.avoidFor;
  if (entry.notes !== undefined) result.notes = entry.notes;
  if (entry.supportsEffort !== undefined) result.supportsEffort = entry.supportsEffort;
  if (entry.input !== undefined) result.inputCostPerMTok = entry.input;
  if (entry.output !== undefined) result.outputCostPerMTok = entry.output;
  if (entry.cachedRead     !== undefined) result.cachedReadCostPerMTok     = entry.cachedRead;
  if (entry.cachedNonRead  !== undefined) result.cachedNonReadCostPerMTok  = entry.cachedNonRead;
  if (entry.reasoning !== undefined) result.reasoningCostPerMTok = entry.reasoning;
  if (entry.inputTokenSoftLimit !== undefined) result.inputTokenSoftLimit = entry.inputTokenSoftLimit;

  return result;
}

// Validate, resolve inheritance, and sort once at module load — longest prefix wins
const PROFILE_ENTRIES: ModelProfile[] = (() => {
  const groups = z.array(providerGroupSchema).safeParse(profileData);
  if (!groups.success) {
    throw new Error(`model-profiles.json is invalid: ${groups.error.message}`);
  }

  const resolved = new Map<string, ModelProfile>();

  for (const group of groups.data) {
    // Sort by prefix length (shortest first) so parents resolve before children
    const sorted = [...group.profiles].sort((a, b) => a.prefix.length - b.prefix.length);

    for (const entry of sorted) {
      const profile = resolveEntry(
        entry,
        group.defaults,
        { rateSource: group.rateSource, rateLookupDate: group.rateLookupDate },
        resolved,
      );

      const valid = modelProfileSchema.safeParse(profile);
      if (!valid.success) {
        throw new Error(`model-profiles.json: resolved profile "${entry.prefix}" is invalid: ${valid.error.message}`);
      }

      resolved.set(entry.prefix, valid.data);
    }
  }

  // Return sorted by prefix length descending (longest prefix wins on lookup)
  return [...resolved.values()].sort((a, b) => b.prefix.length - a.prefix.length);
})();

// Precompute lowercase prefixes once at module load. findModelProfile is in the
// hot path for telemetry normalization and cost compute; lowercasing each
// prefix per call would re-allocate N strings per lookup.
const PROFILE_LOOKUP: ReadonlyArray<{ entry: ModelProfile; prefixLc: string }> =
  Object.freeze(PROFILE_ENTRIES.map(e => Object.freeze({
    entry: Object.freeze(e) as ModelProfile,
    prefixLc: e.prefix.toLowerCase(),
  })));

const FROZEN_DEFAULT_PROFILE: ModelProfile = Object.freeze({ ...DEFAULT_PROFILE });

/**
 * Used for model COST/PROFILE lookup only — NOT a telemetry allowlist.
 * Adding/removing entries here does NOT affect what telemetry accepts.
 * Telemetry uses BoundedIdentifier (telemetry/types.ts) and accepts any
 * reasonable string identifier; see PRIVACY.md for the wire-shape rules.
 */
export const ALL_MODEL_IDS: readonly string[] = Object.freeze(
  PROFILE_ENTRIES
    .map(p => p.prefix)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
);

export function findModelProfile(modelId: string): ModelProfile {
  const normalized = extractCanonicalModelName(modelId).toLowerCase();
  for (const { entry, prefixLc } of PROFILE_LOOKUP) {
    if (normalized.startsWith(prefixLc)) return entry;
  }
  return FROZEN_DEFAULT_PROFILE;
}

export function getEffectiveCostTier(config: ProviderConfig): CostTier {
  return config.costTier ?? findModelProfile(config.model).defaultCost;
}

function stripLeadingNamespace(raw: string): string {
  let result = raw;
  let changed = true;

  while (changed) {
    changed = false;
    const lower = result.toLowerCase();

    const multiDot = lower.match(/^[a-z]{2,3}\.[a-z]+\./);
    if (multiDot) {
      result = result.slice(multiDot[0].length);
      changed = true;
      continue;
    }

    for (const prefix of SLASH_VENDOR_PREFIXES) {
      if (lower.startsWith(prefix)) {
        result = result.slice(prefix.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    const genericSlash = lower.match(/^[a-z][a-z0-9-]*\//);
    if (genericSlash) {
      result = result.slice(genericSlash[0].length);
      changed = true;
      continue;
    }

    for (const prefix of DOT_VENDOR_PREFIXES) {
      if (lower.startsWith(prefix)) {
        result = result.slice(prefix.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (const prefix of DASH_VENDOR_PREFIXES) {
      if (lower.startsWith(prefix)) {
        result = result.slice(prefix.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    const colon = lower.match(/^[a-z]{2,6}:/);
    if (colon) {
      result = result.slice(colon[0].length);
      changed = true;
    }
  }

  if (result.toLowerCase().startsWith('meta-llama/')) {
    result = result.slice('meta-llama/'.length);
  }

  return result;
}

function stripTrailingMarkers(raw: string): string {
  let result = raw;
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of TRAILING_MARKERS) {
      const next = result.replace(marker, '');
      if (next !== result) {
        result = next;
        changed = true;
        break;
      }
    }
  }
  return result;
}

function longestPrefixCanonical(candidate: string): string | null {
  const normalized = candidate.toLowerCase();
  let best: ModelProfile | null = null;
  for (const entry of PROFILE_ENTRIES) {
    if (!normalized.startsWith(entry.prefix.toLowerCase())) continue;
    if (!best || entry.prefix.length > best.prefix.length) {
      best = entry;
    }
  }
  return best?.prefix ?? null;
}
