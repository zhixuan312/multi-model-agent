import type { Pricing } from '../config/load.js';

export interface TierModelProfile {
  model: string;
  pricing: Pricing;
}

export class AgentResolver {
  constructor(private profiles: Map<'standard' | 'complex', TierModelProfile>) {}

  resolve(tier: 'standard' | 'complex'): TierModelProfile {
    const p = this.profiles.get(tier);
    if (!p) throw new Error(`no profile for tier '${tier}'`);
    return { model: p.model, pricing: p.pricing };
  }
}
