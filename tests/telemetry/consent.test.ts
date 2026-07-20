import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const homeDir = '/tmp/mma-test-home';

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

import { decide } from '../../packages/server/src/telemetry/consent';

describe('consent', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MMA_TELEMETRY;
    delete process.env.MMA_TELEMETRY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MMA_TELEMETRY;
    } else {
      process.env.MMA_TELEMETRY = originalEnv;
    }
  });

  // -- decide() -------------------------------------------------------

  it('env=1 → enabled:true, source:env', () => {
    process.env.MMA_TELEMETRY = '1';
    readFileSyncMock.mockReturnValue('{}');

    expect(decide(homeDir)).toEqual({ enabled: true, source: 'env' });
  });

  it('env absent + config.telemetry.enabled=true → enabled:true, source:config', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir)).toEqual({ enabled: true, source: 'config' });
  });

  it('env absent + config absent (ENOENT) → enabled:false, source:default', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileSyncMock.mockImplementation(() => { throw err; });

    expect(decide(homeDir)).toEqual({ enabled: false, source: 'default' });
  });

  it('accepts bare top-level enabled shape as fallback', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ enabled: true }));

    expect(decide(homeDir)).toEqual({ enabled: true, source: 'config' });
  });

  it('prefers telemetry.enabled when both shapes present', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      enabled: false,
      telemetry: { enabled: true },
    }));

    expect(decide(homeDir)).toEqual({ enabled: true, source: 'config' });
  });

  it('config parse failure → enabled:false, source:config_unreadable', () => {
    readFileSyncMock.mockReturnValue('not-json{{{');

    expect(decide(homeDir)).toEqual({ enabled: false, source: 'config_unreadable' });
  });

  it('env=invalidTypo → enabled:false, source:env_invalid (blocks config)', () => {
    process.env.MMA_TELEMETRY = 'invalidTypo';
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir)).toEqual({ enabled: false, source: 'env_invalid' });
  });

  it('env="" + config.telemetry.enabled=true → config wins', () => {
    process.env.MMA_TELEMETRY = '';
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir)).toEqual({ enabled: true, source: 'config' });
  });
});
