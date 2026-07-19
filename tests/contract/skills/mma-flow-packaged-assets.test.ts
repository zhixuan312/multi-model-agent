import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS, readCommandContent } from '../../../packages/server/src/skill-install/discover.js';

const root = path.resolve('packages/server/src/skills/mma-flow');
const skillsRoot = path.resolve('packages/server/src/skills');

// AC-5.1 / AC-5.2 — the parent-aware skill sweep. CHANGED skills must each contain ALL their
// required substrings (case-insensitive); UNCHANGED skills are deliberately left non-parent-aware.
// These two maps ARE the machine-checkable mirror of the spec's Skill sweep inventory table.
const CHANGED: Record<string, string[]> = {
  'mma-flow': [
    'topology detection', 'immediate child', 'does not recurse', 'does not follow symlinks',
    'multi-repo mode', 'single-project', 'involved repo', 're-prompt', 'slug collision',
    'parent workspace', 'design/<stem>.md', 'one plan per repo', 'in-place', 'no pr (non-git target)',
  ],
  'multi-model-agent': ['multi-repo', 'single-project'],
  'mma-explore': ['multi-repo mode', 'parent workspace', '.mma/explorations'],
  'mma-brainstorm': ['involved repo', 'parent workspace'],
  'mma-spec': ['parent workspace owns the spec output in multi-repo mode', 'one shared spec feeds per-repo plans'],
  'mma-plan': ['one repo', 'exactly one repo', 'shared spec', '.mma/plans/<stem>--<repo-slug>.md'],
  'mma-journal-record': ['parent', 'journal', 'topic = <repo-slug>', 'lowercase-kebab'],
  'mma-journal-recall': ['parent', 'journal', 'topic = <repo-slug>', 'lowercase-kebab'],
  'mma-delegate': ['non-git', 'in-place', 'no worktree'],
  'mma-execute-plan': ['non-git', 'in-place', 'one plan file'],
};

const UNCHANGED = [
  'mma-audit', 'mma-context-blocks', 'mma-debug', 'mma-investigate',
  'mma-orchestrate', 'mma-research', 'mma-retry', 'mma-review', 'mma-breakout',
];

describe('contract: mma-flow packaged assets', () => {
  it('mma-flow is in SUPPORTED_COMMANDS (not SUPPORTED_SKILLS)', () => {
    expect(SUPPORTED_COMMANDS).toContain('mma-flow');
    expect(SUPPORTED_SKILLS).not.toContain('mma-flow');
  });

  it('ships the SKILL.md with no superpowers references', () => {
    const skillMd = path.join(root, 'SKILL.md');
    expect(existsSync(skillMd), skillMd).toBe(true);
    expect(readFileSync(skillMd, 'utf8')).not.toContain('superpowers:');
  });

  it('does not ship any workflow scripts', () => {
    expect(existsSync(path.join(root, 'workflows'))).toBe(false);
  });

  it('B5 encodes the one-request-per-repo dispatch invariant + multi-repo fan-out', () => {
    const skill = readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    // The dispatch unit is the repo, never the task: B5 runs once per repo, and an
    // empty tasks[] runs the whole plan (no per-task fragmentation of a single repo).
    // tasks[] only partitions a multi-repo plan. This guards the bug where a
    // single-repo plan was fragmented into many execute_plan requests.
    expect(skill).toContain('once per repo');
    expect(skill).toContain('empty = whole plan');
    expect(skill).toContain('Common: Multi-repo');
  });

  it('readCommandContent reads mma-flow SKILL.md from the skills root', () => {
    const content = readCommandContent('mma-flow');
    expect(content).toBeTruthy();
    expect(content).toContain('name: mma-flow');
    expect(content).toContain('Claude Code command');
  });

  it('readCommandContent returns null for nonexistent commands', () => {
    expect(readCommandContent('mma-nonexistent')).toBeNull();
  });

  // ── Parent-aware multi-repo skill sweep (AC-5.1 / AC-5.2) ──

  it('AC-5.2: every changed skill contains its required parent-aware substrings', () => {
    for (const [skillName, substrings] of Object.entries(CHANGED)) {
      const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
      expect(existsSync(skillPath), `${skillName} SKILL.md not found`).toBe(true);
      const content = readFileSync(skillPath, 'utf8').toLowerCase();
      for (const substring of substrings) {
        expect(
          content.includes(substring.toLowerCase()),
          `${skillName} missing substring: "${substring}"`,
        ).toBe(true);
      }
    }
  });

  it('AC-5.1: the changed+unchanged inventory covers every packaged skill exactly once', () => {
    const onDisk = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(skillsRoot, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
    const classified = [...Object.keys(CHANGED), ...UNCHANGED].sort();
    const classifiedSet = new Set(classified);
    // Completeness: the inventory names exactly the set of packaged skills on disk — nothing missed.
    expect(classified).toEqual(onDisk);
    // Disjointness: no skill is both changed and unchanged.
    expect(classifiedSet.size).toBe(classified.length);
    // Registry-drift guard: every installable skill + command must be classified.
    for (const id of [...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS]) {
      expect(classifiedSet.has(id), `registry skill "${id}" not classified in the sweep inventory`).toBe(true);
    }
  });

  it('AC-5.1: unchanged skills carry no parent-aware markers (sweep deliberately left them alone)', () => {
    for (const skillName of UNCHANGED) {
      const content = readFileSync(path.join(skillsRoot, skillName, 'SKILL.md'), 'utf8').toLowerCase();
      expect(content.includes('topology detection'), `${skillName} unexpectedly parent-aware`).toBe(false);
    }
  });
});
