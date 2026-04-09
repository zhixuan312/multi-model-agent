# Model Routing Guidance — Design

**Date:** 2026-04-09
**Status:** Draft (awaiting review)
**Scope:** v0.1.x of `multi-model-agent`

## Problem

The MCP server exposes one tool — `delegate_tasks` — and the consumer LLM (typically Claude) decides which provider each subtask routes to. Today the tool description only lists provider names, so the consumer has no basis for picking well. Two failure modes result:

1. **Quality mismatch (highest priority).** A complex or ambiguous task gets routed to a small/cheap model that can't reason through it. The task technically completes, but the output is shallow or wrong, and nobody notices until the result is read.
2. **Capability mismatch.** A task that needs a specific tool (e.g., web search) gets routed to a provider without that tool. The sub-agent silently degrades — e.g., returns "here are some links you could try" instead of actual data. We have direct evidence of this from a recent weather-lookup test where MiniMax was assigned a task it couldn't perform.

Secondary concerns: wasted spend (sending trivial tasks to premium models) and lazy routing (consumer LLM defaults to its own family or to the first provider in the list rather than choosing on merit).

## Goal

Help the consumer LLM choose the right model for each subtask by:

- Giving it the information it needs to decide well (capabilities, quality tiers, cost).
- Forcing it to commit to a quality and capability assessment per task, breaking lazy-default routing.
- Making cost a *strong* preference (not a weak tiebreaker) so users with flat-rate or self-hosted providers actually benefit from them.

Non-goal: server-side automatic routing. The consumer LLM stays in charge of decisions; the server provides information and structure.

## Design Anchors

Decisions made during brainstorming, in order:

1. **Optimize for the consumer LLM**, not for the human or for server-side magic. Tokens spent in the tool description are the highest-leverage spend in the system.
2. **Failure mode priority:** quality > capability > cost > avoid blind picking > parallelization. Parallelization is out of scope.
3. **Self-judgment with anchored heuristics.** The consumer LLM judges task complexity itself, but the tool description provides explicit heuristics so judgment is anchored.
4. **All routing guidance lives in the `delegate_tasks` tool description.** No separate `list_providers` tool, no MCP resources. Loaded once per session, cached, available for every call.
5. **Forced schema fields as a commitment device.** The consumer LLM must declare task properties before submitting. This isn't ceremony — it prevents lazy routing to a default provider, which is the dominant failure mode when the consumer LLM is also the orchestrator.
6. **Cost is config-overridable** because it varies by user deployment (flat-rate plans, self-hosting, free tiers). Quality and capability are intrinsic to the model and stay hardcoded.

## Architecture

Three new modules and two touchpoints in existing files.

```
src/
  routing/
    capabilities.ts      NEW — capability map by provider type
    model-profiles.ts    NEW — quality tier map by model family
    describe.ts          NEW — renders the matrix for the tool description
  config.ts              MODIFIED — adds optional costTier field
  types.ts               MODIFIED — adds Tier, Capability, costTier
  cli.ts                 MODIFIED — injects describe() into tool description,
                                    adds tier/requiredCapabilities to schema
```

### Module 1: `src/routing/capabilities.ts`

Hardcoded map: provider type → list of capabilities the provider's runner supports out of the box. Plus a function that merges in `hostedTools` from config.

```ts
export type Capability =
  | 'file_read' | 'file_write' | 'grep' | 'glob'
  | 'shell' | 'web_search' | 'web_fetch';

const BASE_CAPABILITIES: Record<ProviderType, Capability[]> = {
  'codex':             ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search'],
  'claude':            ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch'],
  'openai-compatible': ['file_read', 'file_write', 'grep', 'glob'],
};

export function getCapabilities(config: ProviderConfig): Capability[] {
  const base = BASE_CAPABILITIES[config.type];
  const hostedWebSearch = (config.hostedTools ?? []).includes('web_search') ? ['web_search' as Capability] : [];
  return Array.from(new Set([...base, ...hostedWebSearch]));
}
```

Only `web_search` from `hostedTools` is mapped onto the capability vocabulary in v1, because it's the only hosted tool that matters for routing decisions today. `image_generation` and `code_interpreter` are still accepted in `hostedTools` config (existing behavior) but aren't part of the forced-declaration vocabulary — no current task type requires declaring them, and adding them would be speculative.

### Module 2: `src/routing/model-profiles.ts`

Hardcoded map: model family prefix → quality profile. Matched longest-prefix-first against `config.providers[name].model`, case-insensitive.

```ts
export type Tier = 'trivial' | 'standard' | 'reasoning';
export type CostTier = 'free' | 'low' | 'medium' | 'high';

export interface ModelProfile {
  tier: Tier;
  defaultCost: CostTier;
  bestFor: string;
  avoidFor?: string;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-opus': {
    tier: 'reasoning',
    defaultCost: 'high',
    bestFor: 'complex, uncertain, open-ended tasks requiring judgment',
  },
  'claude-sonnet': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'well-scoped code and analysis',
  },
  'gpt-5': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'code implementation + live data lookup',
  },
  'MiniMax-M2': {
    tier: 'standard',
    defaultCost: 'low',
    bestFor: 'well-defined local code tasks with explicit requirements',
    avoidFor: 'ambiguous or research-style tasks',
  },
};

const DEFAULT_PROFILE: ModelProfile = {
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
};

export function findProfile(modelId: string): ModelProfile {
  const normalized = modelId.toLowerCase();
  const keys = Object.keys(MODEL_PROFILES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key.toLowerCase())) return MODEL_PROFILES[key];
  }
  return DEFAULT_PROFILE;
}

export function effectiveCost(config: ProviderConfig): CostTier {
  return config.costTier ?? findProfile(config.model).defaultCost;
}
```

Longest-prefix-first means `gpt-5-codex` would match `gpt-5-codex` if added later, otherwise falls through to `gpt-5`.

### Module 3: `src/routing/describe.ts`

Renders the matrix and routing recipe into a single string for the tool description.

```ts
export function describeProviders(config: MultiModelConfig): string {
  const providers = Object.entries(config.providers).map(([name, pc]) => {
    const profile = findProfile(pc.model);
    const caps = getCapabilities(pc);
    const cost = effectiveCost(pc);
    const costSource = pc.costTier ? ' (from config)' : '';
    return renderProviderBlock(name, pc.model, caps, profile, cost, costSource);
  });

  return [
    'Available providers:',
    '',
    providers.join('\n\n'),
    '',
    ROUTING_RECIPE,
  ].join('\n');
}
```

The static `ROUTING_RECIPE` block:

```
How to route a task:
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
```

Estimated rendered size for a 3-provider config: ~350 tokens. Well under the 500-token soft budget agreed during brainstorming.

### Module 4: `src/config.ts` modifications

Add `costTier` as an optional field on `providerConfigSchema`:

```ts
costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
```

No breaking changes to existing configs.

### Module 5: `src/types.ts` modifications

Add the new types and extend `ProviderConfig`:

```ts
export type Tier = 'trivial' | 'standard' | 'reasoning';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type Capability =
  | 'file_read' | 'file_write' | 'grep' | 'glob'
  | 'shell' | 'web_search' | 'web_fetch';

export interface ProviderConfig {
  // ... existing fields
  costTier?: CostTier;
}
```

`Capability` is the canonical vocabulary used by both the capability map and the schema's `requiredCapabilities` field.

### Module 6: `src/cli.ts` modifications

Two changes to `buildMcpServer`:

1. **Inject the matrix into the tool description.** Replace the current single-line description with `describeProviders(config)`.
2. **Add forced schema fields.** Two new required fields on each task:

```ts
tasks: z.array(z.object({
  prompt: z.string().describe('Task prompt for the sub-agent'),
  provider: z.enum(availableProviders).describe('Provider name'),
  tier: z.enum(['trivial', 'standard', 'reasoning'])
    .describe('Required quality tier. See routing recipe in tool description.'),
  requiredCapabilities: z.array(z.enum([
    'file_read', 'file_write', 'grep', 'glob',
    'shell', 'web_search', 'web_fetch',
  ])).describe('Capabilities the task needs. Empty array if none.'),
  // ... existing optional fields unchanged
}))
```

Both fields are **required** — that is the entire point. They become the commitment device that forces the consumer LLM to think before routing.

The `DelegateTask` type in `src/types.ts` gains the same two fields (also required there). They flow through `delegateAll` unchanged for v1 — neither runner consumes them yet. They exist to force the consumer LLM's judgment and to be available for future server-side validation.

## Data Flow

1. **MCP connect.** Server reads config, calls `describeProviders(config)`, sets the resulting string as the `delegate_tasks` tool description. Sent to the client once during MCP handshake. Cached for the rest of the session.
2. **Per-task delegation.** Consumer LLM constructs a `delegate_tasks` call. For each task it must populate `tier` and `requiredCapabilities` based on the prompt content and the matrix it has in context. Schema validation rejects calls with missing fields.
3. **Sub-agent execution.** Existing code path. The new fields are passed through but don't change runner behavior in v1.
4. **Response.** Existing response shape. No changes.

## Error Handling

Schema-level enforcement only in v1:

- Missing `tier` or `requiredCapabilities` → Zod validation rejects the call before any sub-agent runs. The consumer LLM sees the validation error and retries with the fields filled in.
- Invalid tier or capability values → same.
- Unknown provider → existing behavior (Zod enum validation).

**Not in v1, but mentioned for awareness:** future versions could validate that the chosen provider actually has the declared `requiredCapabilities` and reject mismatches at the server. This would convert the capability-mismatch failure mode from "silent degradation in the sub-agent" to "rejected at the schema layer." Schema is designed to make this trivial to add later.

## Testing

All tests use Vitest, mirror source structure under `tests/`, follow the project's existing patterns.

- `tests/routing/capabilities.test.ts` — `getCapabilities()` returns the right set per provider type, merges hosted tools, deduplicates.
- `tests/routing/model-profiles.test.ts` — `findProfile()` exact match, family-prefix match, longest-prefix-wins (`gpt-5-codex` beats `gpt-5` if both exist), case-insensitivity, default fallback. `effectiveCost()` uses config override when present, falls back to family default otherwise.
- `tests/routing/describe.test.ts` — `describeProviders()` renders all providers, shows `(from config)` annotation when `costTier` is overridden, includes the routing recipe block, fits within token budget (assert string length under a threshold as a proxy).
- `tests/cli.test.ts` — extended to verify the tool description is non-trivial (contains the matrix and recipe markers) and that `tier` / `requiredCapabilities` are required schema fields (Zod parse fails without them).

No mocking of providers needed for any of these tests — they're all pure functions over config.

## Out of Scope (v1)

Per `development-mode.md` ("no premature abstraction"), explicitly deferred:

- Server-side validation that the chosen provider actually has the declared capabilities. Schema makes this easy to add later when there's a real need.
- Soft-warning logs when a paid provider is picked while a `free` provider qualified. Same reason.
- Profile override beyond `costTier` (e.g., overriding `tier` or `bestFor` per provider in config). Cost is the only profile dimension that legitimately varies by user deployment.
- A separate `list_providers` MCP tool. The tool description is the single source of truth.
- MCP resources for providers. Consumer support is uneven and the tool description already covers the use case.
- Parallelization guidance (when to split a task into N subtasks vs send as one). Lower priority and orthogonal to model selection.
- Cost-sensitivity as a per-task forced field. The strong-preference rule in the routing recipe makes it global, which is correct: "prefer cheap when capability allows" doesn't need to be re-declared per task.

## Migration

Per `development-mode.md`, no backward compatibility code. The two new schema fields are required from v0.1.x onward. Any existing consumer of `delegate_tasks` will need to update their calls to include `tier` and `requiredCapabilities`. This is acceptable for a v0.x project.

## Open Questions

None for v1. All design decisions resolved during brainstorming.
