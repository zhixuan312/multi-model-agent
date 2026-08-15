import { USER_AGENT, composeUserAgentForTests } from '../../packages/core/src/research/user-agent.js';

describe('user-agent', () => {
  it('matches mma-research/<semver> when package.json reads OK', () => {
    expect(USER_AGENT).toMatch(/^mma-research\/(\d+\.\d+\.\d+|0\.0\.0-unknown)$/);
  });

  it('falls back to mma-research/0.0.0-unknown when version field is invalid', () => {
    const ua = composeUserAgentForTests({ version: 'not-a-semver' });
    expect(ua).toBe('mma-research/0.0.0-unknown');
  });

  it('falls back to mma-research/0.0.0-unknown when version field is missing', () => {
    const ua = composeUserAgentForTests({});
    expect(ua).toBe('mma-research/0.0.0-unknown');
  });
});
