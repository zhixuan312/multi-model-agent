// Validates each packaged skill's SKILL.md has the required frontmatter
// (name, description, when_to_use, version) and that the endpoint it
// advertises resolves to a real route in the server route manifest.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import routes from '../goldens/routes.json' with { type: 'json' };

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

function extractEndpointPath(md: string): string | null {
  const m = md.match(/^`(GET|POST|DELETE|PUT|PATCH)\s+([^`?]+)`/m);
  if (!m) return null;
  return `${m[1]!} ${m[2]!.trim()}`;
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

      it('declares an endpoint that resolves to a real route (when applicable)', () => {
        const endpoint = extractEndpointPath(md);
        if (endpoint === null) return;
        const normalized = endpoint.replace(/\{(\w+)\}/g, ':$1').replace('/:id', '/:batchId');
        const matches = (routes as string[]).some((r) => {
          const [method, path] = r.split(' ');
          const [endpointMethod, endpointPath] = normalized.split(' ');
          if (method !== endpointMethod) return false;
          const pathRe = new RegExp('^' + path!.replace(/:\w+/g, ':[^/]+') + '$');
          return pathRe.test(endpointPath!) || path === endpointPath;
        });
        expect(matches, `endpoint ${normalized} not found in route manifest`).toBe(true);
      });
    });
  }
});
