import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { pickSkillsRoot, skillsRootCandidates } from '../../packages/server/src/skill-install/discover.js';

// Regression for v4.0.1: install-skill broke globally because locateSkillsRoot
// only knew the monorepo dev layout. These tests pin the candidate paths for
// both the npm-install hoisted layout and the core-nested-under-server layout.

describe('pickSkillsRoot — npm-installed layouts', () => {
  // `here`/`target` are built with path.resolve so they are OS-native: the
  // product resolves candidates via node:path (backslashes on Windows), so a
  // hardcoded POSIX `target` string would never satisfy the `p === target`
  // predicate on win32. Each `target` mirrors the matching candidate segments.
  it('resolves to the server package skills dir under hoisted npm layout', () => {
    // here: .../@zhixuan92/multi-model-agent-core/dist/tool-surface
    // target: .../@zhixuan92/multi-model-agent/dist/skills  (candidate #3)
    const here = path.resolve('/fake/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface');
    const target = path.resolve(here, '..', '..', '..', 'multi-model-agent', 'dist', 'skills');
    const resolved = pickSkillsRoot(here, (p) => p === target);
    expect(resolved).toBe(target);
  });

  it('resolves to the server skills dir when core is nested under server', () => {
    // here: .../multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface
    // target: .../multi-model-agent/dist/skills  (candidate #4)
    const here = path.resolve(
      '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface',
    );
    const target = path.resolve(here, '..', '..', '..', '..', '..', 'dist', 'skills');
    const resolved = pickSkillsRoot(here, (p) => p === target);
    expect(resolved).toBe(target);
  });

  it('falls back to the dev-source layout when running from packages/core/src', () => {
    // here: <repo>/packages/core/src/tool-surface
    // target: <repo>/packages/server/src/skills  (candidate #1)
    const here = path.resolve('/repo/packages/core/src/tool-surface');
    const target = path.resolve(here, '..', '..', '..', 'server', 'src', 'skills');
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
