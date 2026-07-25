// Reasoning-effort resolution shared by every runner. One chokepoint so
// claude and codex agree on both the default and the capability gate —
// a tier that runs `high` on claude must run `high` on codex too.
//
// Two rules:
//   1. Default. An agent config without `effort` runs at DEFAULT_EFFORT
//      ('high'). Config sets the level per tier; nothing else overrides it.
//   2. Capability gate. `type` is a wire protocol, not a vendor — a
//      claude-typed agent can point at GLM and a codex-typed agent at
//      DeepSeek. Those endpoints reject (or ignore) a reasoning-effort
//      parameter, so effort is only emitted for models whose profile says
//      `supportsEffort`. Unrecognised model ids fall back to the registry's
//      default profile (supportsEffort: false) and send nothing.

import type { Effort } from '../types/task-spec.js';
import { DEFAULT_EFFORT } from '../types/task-spec.js';
import { findModelProfile } from '../config/model-profile-registry.js';

/**
 * Effective effort for a model, or `undefined` when the runner must not send
 * one at all (model has no effort knob).
 */
export function resolveEffort(model: string, configured?: Effort): Effort | undefined {
  if (!findModelProfile(model).supportsEffort) return undefined;
  return configured ?? DEFAULT_EFFORT;
}
