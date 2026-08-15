// Validates each packaged skill's SKILL.md has the required frontmatter
// (name, description, when_to_use, version) and that the endpoint it
// advertises resolves to a real route in the server route manifest.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INITIATIVE_OPERATIONS } from '@zhixuan92/multi-model-agent-core';

const SKILLS_DIR = resolve('packages/server/src/skills');

interface Frontmatter {
  name: string;
  description: string;
  when_to_use: string;
  version: string;
  'disable-model-invocation'?: string;
}

function parseFrontmatter(md: string): Frontmatter {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('no frontmatter');
  const block = match[1]!;
  const fm: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1]!;
      fm[currentKey] = kv[2]!.replace(/^"(.*)"$/, '$1');
    } else if (currentKey && line.trim()) {
      fm[currentKey] = `${fm[currentKey] ?? ''} ${line.trim()}`;
    }
  }
  return fm as unknown as Frontmatter;
}

const ACTIONABLE_SKILLS = [
  'mma-audit',
  'mma-brainstorm',
  'mma-breakout',
  'mma-context-blocks',
  'mma-debug',
  'mma-deck',
  'mma-delegate',
  'mma-execute-plan',
  'mma-explore',
  'mma-flow',
  'mma-journal-record',
  'mma-journal-recall',
  'mma-orchestrate',
  'mma-plan',
  'mma-review',
  'mma-investigate',
  'mma-research',
  'mma-solution-lead',
  'mma-spec',
  'mma-tldr',
];

// Commands are explicitly invoked via /name. They are never auto-matched by
// intent, so the "Use when" description convention does not apply to them, and
// each one must carry the frontmatter key that actually enforces manual
// invocation. `when_to_use` is descriptive prose and enforces nothing.
const COMMANDS = ['mma-flow', 'mma-breakout', 'mma-tldr', 'mma-deck'];

/** Skills that run no worker at all — they transform text in the caller's own context. */
const DISPATCHES_NOTHING = ['mma-tldr'];

describe('contract: skill manifest surface', () => {
  const allSkillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('mma-'))
    .map((e) => e.name)
    .sort();

  it('covers every actionable skill', () => {
    expect(allSkillDirs).toEqual([...ACTIONABLE_SKILLS].sort());
  });

  for (const skillName of ACTIONABLE_SKILLS) {
    describe(skillName, () => {
      const md = readFileSync(resolve(SKILLS_DIR, skillName, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(md);

      it('has required frontmatter keys', () => {
        expect(fm.name).toBe(skillName);
        expect(fm.description.length).toBeGreaterThan(20);
        expect(fm.when_to_use.length).toBeGreaterThan(20);
        expect(fm.version).toMatch(/^(\d+\.\d+\.\d+|0\.0\.0-unreleased)/);
      });

      it('a command enforces manual invocation, and a skill does not disable it', () => {
        if (COMMANDS.includes(skillName)) {
          expect(
            fm['disable-model-invocation'],
            `${skillName} is a command: it must set disable-model-invocation: true. `
              + 'when_to_use is prose and enforces nothing, so without this key the agent '
              + 'may invoke the command automatically from intent matching.',
          ).toBe('true');
          return;
        }
        expect(
          fm['disable-model-invocation'],
          `${skillName} is an auto-matched skill and must stay model-invokable`,
        ).toBeUndefined();
      });

      it('description starts with "Use when" or "Use first" (skill-discovery convention)', () => {
        // Commands (e.g. mma-flow) are explicitly invoked via /name, not auto-matched
        // by intent — the "Use when" convention does not apply to them.
        if (COMMANDS.includes(skillName)) return;

        expect(
          fm.description,
          `${skillName} description must start with "Use when" or "Use first" — see docs/SKILL_WRITING_GUIDELINES.md rule #1`,
        ).toMatch(/^Use (when|first)\b/);
      });

      /**
       * Every actionable skill must name a real way to dispatch.
       *
       * This case used to extract a `` `POST /execution` ``-style endpoint from the markdown and
       * check it against the route manifest — with `if (endpoint === null) return;` when it found
       * none. NO skill declares an endpoint any more: they dispatch through the `mma_run` MCP
       * tool. So the case ran twenty times and asserted nothing, and its route-matching machinery
       * (including a `/:id` → `/:batchId` rewrite for a parameter the manifest no longer has) was
       * dead with it.
       *
       * The live equivalent: a skill dispatches via `mma_run`, OR declares `operation_references`
       * naming real frozen Initiative operations, OR is a command that dispatches nothing.
       */
      it('names a real dispatch surface — mma_run, Initiative operations, or nothing to dispatch', () => {
        // Being a COMMAND says nothing about dispatch: `/mma-flow` and `/mma-breakout` are
        // explicitly-invoked commands that orchestrate `mma_run` calls. Only a skill that
        // genuinely runs no worker is exempt, and it is named here rather than inferred.
        if (DISPATCHES_NOTHING.includes(skillName)) {
          expect(md, `${skillName} is listed as dispatching nothing but references mma_run`).not.toContain('mma_run');
          return;
        }
        const declaresOperations = /^operation_references:/m.test(md);
        if (declaresOperations) {
          const block = md.slice(md.indexOf('operation_references:')).split(/\n(?=\w|---)/)[0]!;
          const declared = [...block.matchAll(/^\s+-\s+(\S+)/gm)].map((m) => m[1]!);
          expect(declared.length, `${skillName} declares an empty operation_references`).toBeGreaterThan(0);
          for (const operation of declared) {
            expect(
              (INITIATIVE_OPERATIONS as readonly string[]).includes(operation),
              `${skillName} references "${operation}", which is not a frozen Initiative operation`,
            ).toBe(true);
          }
          return;
        }
        expect(md, `${skillName} names neither mma_run nor operation_references`).toContain('mma_run');
      });

    });
  }
});
