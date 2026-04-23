import { describe, it, expect } from 'vitest';
import { serverConfigSchema } from '@zhixuan92/multi-model-agent-core/config/schema';
import { loadAuthToken } from '@zhixuan92/multi-model-agent-core/config/load';

describe('server config', () => {
  it('parses flat server.* config', () => {
    const parsed = serverConfigSchema.parse({
      server: {
        bind: '127.0.0.1',
        port: 7337,
        auth: { tokenFile: '~/.multi-model/auth-token' },
        limits: {
          maxBodyBytes: 10_485_760,
          batchTtlMs: 3_600_000,
          idleProjectTimeoutMs: 1_800_000,
          clarificationTimeoutMs: 86_400_000,
          projectCap: 200,
          maxBatchCacheSize: 500,
          maxContextBlockBytes: 524_288,
          maxContextBlocksPerProject: 32,
          shutdownDrainMs: 30_000,
        },
      },
    });
    expect(parsed.server.port).toBe(7337);
  });

  it('rejects legacy transport.mode config', () => {
    expect(() => serverConfigSchema.parse({ transport: { mode: 'http' } })).toThrow();
  });

  it('MMAGENT_AUTH_TOKEN env override wins over file', () => {
    process.env['MMAGENT_AUTH_TOKEN'] = 'from-env';
    const token = loadAuthToken({ tokenFile: '/nonexistent' });
    expect(token).toBe('from-env');
    delete process.env['MMAGENT_AUTH_TOKEN'];
  });
});
