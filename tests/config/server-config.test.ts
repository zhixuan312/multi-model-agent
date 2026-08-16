import { describe, it, expect } from 'vitest';
import { serverConfigSchema } from '@zhixuan92/multi-model-agent-core/config/schema';
import { loadAuthToken } from '@zhixuan92/multi-model-agent-core/config/load';

describe('server config', () => {
  it('parses flat server.* config', () => {
    const parsed = serverConfigSchema.parse({
      server: {
        bind: '127.0.0.1',
        port: 7337,
        auth: { tokenFile: '~/.mma/auth-token' },
        limits: {
          maxBodyBytes: 10_485_760,
          batchTtlMs: 3_600_000,
          projectCap: 200,
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

  it('MMA_AUTH_TOKEN env override wins over file', () => {
    // try/finally, like the sibling case in load-strict-token.test.ts. A bare `delete` after the
    // assertion never runs when the assertion throws, and the leaked token then decides the auth
    // outcome of every later test in this worker — the same env bleed that makes the suite need
    // `env -u MMAGENT_AUTH_TOKEN -u MMA_AUTH_TOKEN` to run clean.
    process.env['MMA_AUTH_TOKEN'] = 'from-env';
    try {
      expect(loadAuthToken({ tokenFile: '/nonexistent' })).toBe('from-env');
    } finally {
      delete process.env['MMA_AUTH_TOKEN'];
    }
  });

  it('server.autoUpdateSkills defaults to true', () => {
    const parsed = serverConfigSchema.parse({ server: {} });
    expect(parsed.server.autoUpdateSkills).toBe(true);
  });

  it('server.autoUpdateSkills can be opted out', () => {
    const parsed = serverConfigSchema.parse({ server: { autoUpdateSkills: false } });
    expect(parsed.server.autoUpdateSkills).toBe(false);
  });
});
