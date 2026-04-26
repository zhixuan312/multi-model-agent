import { describe, it, expect } from 'vitest';
import { decideConsent, type ConsentDecision } from '../../packages/core/src/telemetry/consent-rules.js';

describe('consent-rules — pure decision (env, config) → decision', () => {
  // ENV precedence — first non-empty value
  it('env=0 → enabled:false, source:env', () => {
    expect(decideConsent({ env: '0', config: undefined })).toEqual({ enabled: false, source: 'env' });
  });
  it('env=false → enabled:false', () => expect(decideConsent({ env: 'false', config: undefined })).toEqual({ enabled: false, source: 'env' }));
  it('env=FALSE (case insensitive) → enabled:false', () => expect(decideConsent({ env: 'FALSE', config: undefined })).toEqual({ enabled: false, source: 'env' }));
  it('env=off → enabled:false', () => expect(decideConsent({ env: 'off', config: undefined })).toEqual({ enabled: false, source: 'env' }));
  it('env=no → enabled:false', () => expect(decideConsent({ env: 'no', config: undefined })).toEqual({ enabled: false, source: 'env' }));

  it('env=1 → enabled:true', () => expect(decideConsent({ env: '1', config: undefined })).toEqual({ enabled: true, source: 'env' }));
  it('env=true → enabled:true', () => expect(decideConsent({ env: 'true', config: undefined })).toEqual({ enabled: true, source: 'env' }));
  it('env=on → enabled:true', () => expect(decideConsent({ env: 'on', config: undefined })).toEqual({ enabled: true, source: 'env' }));
  it('env=yes → enabled:true', () => expect(decideConsent({ env: 'yes', config: undefined })).toEqual({ enabled: true, source: 'env' }));

  // Invalid env — fail closed
  it('env=fales (typo) → enabled:false, source:env_invalid', () => {
    expect(decideConsent({ env: 'fales', config: undefined })).toEqual({ enabled: false, source: 'env_invalid' });
  });

  // Empty / unset env falls through to config
  it('env="" + config:false → enabled:false, source:config', () => {
    expect(decideConsent({ env: '', config: { enabled: false } })).toEqual({ enabled: false, source: 'config' });
  });
  it('env=undefined + config:true → enabled:true, source:config', () => {
    expect(decideConsent({ env: undefined, config: { enabled: true } })).toEqual({ enabled: true, source: 'config' });
  });

  // Default
  it('all-empty → 3.6.0 default disabled, source:default', () => {
    expect(decideConsent({ env: undefined, config: undefined })).toEqual({ enabled: false, source: 'default' });
  });

  // Config unreadable
  it('config: {kind:"unreadable"} → enabled:false, source:config_unreadable', () => {
    expect(decideConsent({ env: undefined, config: { kind: 'unreadable' } as any }))
      .toEqual({ enabled: false, source: 'config_unreadable' });
  });
});
