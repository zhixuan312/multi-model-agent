import type { Provider } from '@zhixuan92/multi-model-agent-core';

let testProviderOverride: Provider | null = null;

function assertEnabled(): void {
  if (process.env.MMAGENT_TEST_PROVIDER_OVERRIDE !== '1') {
    throw new Error('MMAGENT_TEST_PROVIDER_OVERRIDE must be set to 1 to use the test provider override');
  }
}

export function __setTestProviderOverride(provider: Provider | null): void {
  assertEnabled();
  testProviderOverride = provider;
}

export function __getTestProviderOverride(): Provider | null {
  if (process.env.MMAGENT_TEST_PROVIDER_OVERRIDE !== '1') {
    return null;
  }
  return testProviderOverride;
}
