import type { ProviderConfig } from '../types.js';

export type EligibilityFailureCheck =
  | 'capability'
  | 'tier'
  | 'tool_mode'
  | 'provider_not_found'
  | 'unsupported_provider_type'
  | 'missing_required_field'
  | string

export interface EligibilityFailure {
  check: EligibilityFailureCheck
  detail: string
  message: string
}

export interface ProviderEligibility {
  name: string
  config: ProviderConfig
  eligible: boolean
  /** Reasons only present when eligible === false. */
  reasons: EligibilityFailure[]
}
