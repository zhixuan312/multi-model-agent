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
export function extractCanonicalModelName(raw: string): string {
  if (!STRICT_ID_REGEX.test(raw)) return 'custom';

  const namespaceStripped = stripLeadingNamespace(raw);
  const preservedMatch = longestPrefixCanonical(namespaceStripped);
  if (preservedMatch) return preservedMatch;

  const fullyStripped = stripTrailingMarkers(namespaceStripped);
  const strippedMatch = longestPrefixCanonical(fullyStripped);
  if (strippedMatch) return strippedMatch;

  return 'custom';
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
  cachedInputCostPerMTok: z.number().finite().nonnegative().optional(),
  reasoningCostPerMTok: z.number().finite().nonnegative().optional(),
  rateSource: z.string().min(1).optional(),
  rateLookupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Per-model-family default for the watchdog input-token soft limit.
   *  See spec A.1.4. */
  inputTokenSoftLimit: z.number().int().positive(),
  capabilities: z.array(z.enum(['web_search', 'web_fetch'])).default([]),
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
  capabilities: [],
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
  cachedInput: z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  inputTokenSoftLimit: z.number().int().positive().optional(),
  capabilities: z.array(z.enum(['web_search', 'web_fetch'])).optional(),
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
    capabilities: z.array(z.enum(['web_search', 'web_fetch'])),
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
  providerDefaults: { family?: ModelFamily; supportsEffort: boolean; inputTokenSoftLimit: number; capabilities: ('web_search' | 'web_fetch')[] },
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
    capabilities: [...providerDefaults.capabilities],
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
    if (parent.cachedInputCostPerMTok !== undefined) result.cachedInputCostPerMTok = parent.cachedInputCostPerMTok;
    if (parent.reasoningCostPerMTok !== undefined) result.reasoningCostPerMTok = parent.reasoningCostPerMTok;
    result.inputTokenSoftLimit = parent.inputTokenSoftLimit;
    result.capabilities = [...parent.capabilities];
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
  if (entry.cachedInput !== undefined) result.cachedInputCostPerMTok = entry.cachedInput;
  if (entry.reasoning !== undefined) result.reasoningCostPerMTok = entry.reasoning;
  if (entry.inputTokenSoftLimit !== undefined) result.inputTokenSoftLimit = entry.inputTokenSoftLimit;
  if (entry.capabilities !== undefined) result.capabilities = [...entry.capabilities];

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
  const canonical = extractCanonicalModelName(modelId);
  const normalized = canonical.toLowerCase();
  for (const entry of PROFILE_ENTRIES) {
    if (normalized.startsWith(entry.prefix.toLowerCase())) {
      return { ...entry };
    }
  }
  return { ...DEFAULT_PROFILE };
}

export function findModelCapabilities(modelId: string): ('web_search' | 'web_fetch')[] {
  return findModelProfile(modelId).capabilities ?? [];
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
