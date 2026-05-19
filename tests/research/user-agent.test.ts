import { USER_AGENT, _resetForTests } from '../../packages/core/src/research/user-agent.js';

describe('user-agent', () => {
  it('matches mma-research/<semver> when package.json reads OK', () => {
    expect(USER_AGENT).toMatch(/^mma-research\/(\d+\.\d+\.\d+|0\.0\.0-unknown)$/);
  });

  it('falls back to mma-research/0.0.0-unknown when version field is invalid', async () => {
    const ua = await _resetForTests({ version: 'not-a-semver' });
    expect(ua).toBe('mma-research/0.0.0-unknown');
  });

  it('falls back to mma-research/0.0.0-unknown when version field is missing', async () => {
    const ua = await _resetForTests({});
    expect(ua).toBe('mma-research/0.0.0-unknown');
  });
});
