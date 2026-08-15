/**
 * Every installed skill must be reachable from the router.
 *
 * `multi-model-agent/SKILL.md` is the skill a calling agent reads to choose among the others, and
 * its own contract is "pick the most specific mma-* skill that fits the task". Five of the
 * seventeen installed skills — `mma-research`, `mma-journal-record`, `mma-journal-recall`,
 * `mma-orchestrate`, `mma-solution-lead` — appeared nowhere in it: not in the decision graph, not
 * in the skill table, not in the prose. Every one is provisioned to every client and has a real
 * SKILL.md on disk.
 *
 * The consequence was not a broken call but an invisible capability. The router terminated
 * external-research questions at `mma-investigate`, whose own doc scopes it to project material,
 * and offered no path at all to record or recall a learning — while describing `mma-explore` as
 * fanning out to "investigate + research + recall" without ever introducing two of those three.
 *
 * Two existing tests looked like they covered this and did not: `provisioning-entry-points-agree`
 * asserts the INSTALLER matches `SUPPORTED_SKILLS`, and the solution-lead contract test asserts
 * that roster CONTAINS its skill. Both are about installation. Nothing asked whether a skill could
 * be chosen once installed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUPPORTED_SKILLS,
  SUPPORTED_COMMANDS,
} from '../../../packages/server/src/skill-install/discover.js';

const ROUTER = 'packages/server/src/skills/multi-model-agent/SKILL.md';
const router = readFileSync(ROUTER, 'utf8');

describe('the router names every installed skill', () => {
  it('has skills to check', () => {
    // A floor: an empty roster would make every case below vacuous.
    expect(SUPPORTED_SKILLS.length).toBeGreaterThan(10);
  });

  it.each([...SUPPORTED_SKILLS])('%s is reachable from the router', (skill) => {
    // The router itself is in SUPPORTED_SKILLS; it need not name itself in its own table.
    if (skill === 'multi-model-agent') return;
    expect(router, `${skill} is installed on every client but appears nowhere in the router`)
      .toContain(skill);
  });

  it.each([...SUPPORTED_COMMANDS])('%s is named in the router', (command) => {
    // Commands are user-invoked rather than agent-routed, but the router is where an agent
    // learns to SUGGEST one, so an unnamed command is equally invisible.
    const bare = command.replace(/^mma-/, '');
    expect(
      router.includes(command) || router.includes(`/mma-${bare}`) || router.includes(`/mma:${bare}`),
      `${command} is packaged but the router never mentions it`,
    ).toBe(true);
  });

  it('does not route to a skill that is not installed', () => {
    // The other direction: a router entry naming something absent is a dead end for the caller.
    const installed = new Set<string>([...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS]);
    const referenced = [...router.matchAll(/`(mma-[a-z-]+)`/g)].map((m) => m[1]!);
    expect(referenced.length, 'found no skill references to check').toBeGreaterThan(5);
    const dangling = [...new Set(referenced)].filter((name) => !installed.has(name));
    expect(dangling, 'the router names skills that are not installed').toEqual([]);
  });
});
