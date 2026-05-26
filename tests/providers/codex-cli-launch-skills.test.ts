import { buildCodexCliLaunch } from '../../packages/core/src/providers/codex-cli-launch.js';

describe('buildCodexCliLaunch codexHome', () => {
  it('sets env.CODEX_HOME when codexHome is provided', () => {
    const l = buildCodexCliLaunch({
      cfg: { model: 'gpt-5.5' }, opts: { cwd: '/w' }, outputFile: '/tmp/o.json', codexHome: '/staged/root',
    });
    expect(l.env.CODEX_HOME).toBe('/staged/root');
  });

  it('does not set CODEX_HOME when codexHome is absent (regression)', () => {
    const before = process.env.CODEX_HOME;
    const l = buildCodexCliLaunch({
      cfg: { model: 'gpt-5.5' }, opts: { cwd: '/w' }, outputFile: '/tmp/o.json',
    });
    expect(l.env.CODEX_HOME).toBe(before); // inherits process env, no override injected
  });
});
