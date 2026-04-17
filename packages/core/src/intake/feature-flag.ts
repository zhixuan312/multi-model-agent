import type { MultiModelConfig } from '../types.js';

export function getMaxRoundsPerDraft(config?: MultiModelConfig): number {
  if (config?.clarifications?.maxRoundsPerDraft !== undefined) {
    return config.clarifications.maxRoundsPerDraft;
  }
  const env = process.env['MULTI_MODEL_CLARIFICATIONS_MAX_ROUNDS'];
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

export interface ClarificationsConfig {
  maxRoundsPerDraft?: number;
}