import type { Capability, MultiModelConfig, ProviderConfig } from '@zhixuan92/multi-model-agent-core';
import { getBaseCapabilities } from '@zhixuan92/multi-model-agent-core/routing/capabilities';
import { findModelProfile, getEffectiveCostTier } from '@zhixuan92/multi-model-agent-core/routing/model-profiles';
import type { ModelProfile } from '@zhixuan92/multi-model-agent-core/routing/model-profiles';

const ROUTING_RECIPE = `How to route a task:
1. Capability filter (HARD): exclude providers missing any required capability.
2. Quality filter: exclude providers whose tier is below the task's tier.
   Tier ordering: trivial < standard < reasoning.
3. Cost preference (STRONG): among the remainder, prefer the cheapest tier.
   If a 'free' provider qualifies, pick it. Only escalate to paid tiers when
   the task tier or required capabilities demand it.

Tier guidance for the consumer LLM:
- 'trivial' — well-defined edits, lookups, formatting. One obvious answer.
- 'standard' — most code work. Clear spec, multiple valid approaches.
- 'reasoning' — ambiguous, architectural, research, or high-stakes.
  Use when requirements are unclear or judgment is required.

Optional 'effort' knob (per task):
- Only providers marked 'effort: supported' in the matrix honor this field.
- Use 'high' for reasoning-tier tasks when you want maximum depth,
  'medium' for balanced, 'low' for fast-but-shallow, 'none' to disable
  thinking entirely on providers that default it on. Omit the field on
  providers that do not support it.`;

const TOOL_NOTES = `Sub-agent tool notes (apply to every provider):
- 'grep' accepts a file OR a directory. When given a directory it searches
  recursively (output is prefixed file:line). Prefer one recursive grep over
  many readFile calls when the worker needs to find usages or patterns.
- Worker output is captured ONLY from the final assistant message. The
  worker should produce its complete answer there; intermediate tool
  results and earlier turns are discarded.
- Tasks that need shell ('pnpm', 'pytest', 'tsc', 'git') only work on
  providers configured with sandboxPolicy: 'none'. Otherwise keep shell
  work on the parent session, not in a delegated sub-agent.`;

function renderProviderBlock(
  name: string,
  config: ProviderConfig,
  capabilities: Capability[],
  profile: ModelProfile,
  costSource: 'config' | 'default',
): string {
  const cost = getEffectiveCostTier(config);
  const costSuffix = costSource === 'config' ? ' (from config)' : '';
  const effortLabel = profile.supportsEffort ? 'supported' : 'not supported';
  const lines = [
    `${name} (${config.model})`,
    `  tools: ${capabilities.join(', ')}`,
    `  tier: ${profile.tier} | cost: ${cost}${costSuffix} | effort: ${effortLabel}`,
    `  best for: ${profile.bestFor}`,
  ];
  if (profile.notes) {
    lines.push(`  note: ${profile.notes}`);
  }
  if (profile.avoidFor) {
    lines.push(`  avoid for: ${profile.avoidFor}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full routing matrix for the MCP tool description.
 * Helps the consuming LLM understand provider capabilities and routing rules.
 */
export function renderProviderRoutingMatrix(config: MultiModelConfig): string {
  const blocks = Object.entries(config.providers).map(([name, providerConfig]) => {
    const capabilities = getBaseCapabilities(providerConfig);
    const profile = findModelProfile(providerConfig.model);
    const costSource: 'config' | 'default' = providerConfig.costTier ? 'config' : 'default';
    return renderProviderBlock(name, providerConfig, capabilities, profile, costSource);
  });

  return [
    'Delegate tasks to sub-agents running on different LLM providers.',
    'All tasks execute concurrently.',
    '',
    'Available providers:',
    '',
    blocks.join('\n\n'),
    '',
    ROUTING_RECIPE,
    '',
    TOOL_NOTES,
  ].join('\n');
}
