import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pickSkillsRoot, skillsRootCandidates } from '../../packages/core/src/tool-surface/discover.js';

// Regression for v4.0.1: install-skill broke globally because locateSkillsRoot
// only knew the monorepo dev layout. These tests pin the candidate paths for
// both the npm-install hoisted layout and the core-nested-under-server layout.

describe('pickSkillsRoot — npm-installed layouts', () => {
  it('resolves to the server package skills dir under hoisted npm layout', () => {
    // Simulated layout:
    //   /opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface  ← here
    //   /opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/skills              ← target
    const here = '/fake/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface';
    const target = '/fake/node_modules/@zhixuan92/multi-model-agent/dist/skills';
    const resolved = pickSkillsRoot(here, (p) => p === target);
    expect(resolved).toBe(target);
  });

  it('resolves to the server skills dir when core is nested under server', () => {
    // Simulated layout (npm hoisting fallback — global install):
    //   /opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface  ← here
    //   /opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/skills                                                       ← target
    const here =
      '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface';
    const target = '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/skills';
    const resolved = pickSkillsRoot(here, (p) => p === target);
    expect(resolved).toBe(target);
  });

  it('falls back to the dev-source layout when running from packages/core/src', () => {
    // Repo dev layout:
    //   <repo>/packages/core/src/tool-surface  ← here
    //   <repo>/packages/server/src/skills      ← target
    const here = '/repo/packages/core/src/tool-surface';
    const target = '/repo/packages/server/src/skills';
    const resolved = pickSkillsRoot(here, (p) => p === target);
    expect(resolved).toBe(target);
  });

  it('lists candidates in dev-first, prod-second order', () => {
    const here = '/repo/packages/core/src/tool-surface';
    const candidates = skillsRootCandidates(here);
    expect(candidates).toEqual([
      path.resolve(here, '..', '..', '..', 'server', 'src', 'skills'),
      path.resolve(here, '..', '..', '..', 'server', 'dist', 'skills'),
      path.resolve(here, '..', '..', '..', 'multi-model-agent', 'dist', 'skills'),
      path.resolve(here, '..', '..', '..', '..', '..', 'dist', 'skills'),
      path.resolve(here, '..', 'skills'),
    ]);
  });
});
