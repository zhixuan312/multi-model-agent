import { describe, it, expect } from 'vitest';
import {
  normalizeHeading,
  parsePlanHeadings,
  matchTasks,
  MatchError,
} from '../../packages/core/src/unified/plan-task-matcher.js';

const SAMPLE_PLAN = `
# Feature Implementation Plan

## Phase 1: Core Setup

### 1. Add schema file

Create the schema.

### 2. Write unit tests

Test the schema.

## Phase 2: Integration

### 3. Wire up handler

Connect to server.

### 4. Add validation

Validate inputs.

## What Doesn't Change

This section is informational.
`;

describe('normalizeHeading', () => {
  it('strips markdown heading prefix', () => {
    expect(normalizeHeading('### 3. Add schema file')).toBe('Add schema file');
  });

  it('strips numbering with dot', () => {
    expect(normalizeHeading('1. Do X')).toBe('Do X');
  });

  it('strips numbering with paren', () => {
    expect(normalizeHeading('2) Do Y')).toBe('Do Y');
  });

  it('strips numbering with dash', () => {
    expect(normalizeHeading('3 - Do Z')).toBe('Do Z');
  });

  it('trims whitespace', () => {
    expect(normalizeHeading('  ## 1. Hello  ')).toBe('Hello');
  });

  it('returns non-numbered heading as-is after stripping #', () => {
    expect(normalizeHeading('## Phase 1: Core Setup')).toBe('Phase 1: Core Setup');
  });
});

describe('parsePlanHeadings', () => {
  it('parses all headings from sample plan', () => {
    const headings = parsePlanHeadings(SAMPLE_PLAN);
    expect(headings.length).toBe(8);
  });

  it('identifies numbered vs non-numbered', () => {
    const headings = parsePlanHeadings(SAMPLE_PLAN);
    const numbered = headings.filter(h => h.isNumbered);
    const phases = headings.filter(h => !h.isNumbered);
    expect(numbered.length).toBe(4);
    expect(phases.length).toBe(4);
  });

  it('tracks parent phase for numbered headings', () => {
    const headings = parsePlanHeadings(SAMPLE_PLAN);
    const task1 = headings.find(h => h.normalized === 'Add schema file')!;
    expect(task1.parentPhase).toBe('Phase 1: Core Setup');

    const task3 = headings.find(h => h.normalized === 'Wire up handler')!;
    expect(task3.parentPhase).toBe('Phase 2: Integration');
  });
});

describe('matchTasks', () => {
  const headings = parsePlanHeadings(SAMPLE_PLAN);

  it('empty selectors returns all numbered headings', () => {
    const matched = matchTasks(headings, []);
    expect(matched.length).toBe(4);
    expect(matched.map(m => m.normalized)).toEqual([
      'Add schema file', 'Write unit tests', 'Wire up handler', 'Add validation',
    ]);
  });

  it('matches by exact title', () => {
    const matched = matchTasks(headings, ['Add schema file']);
    expect(matched.length).toBe(1);
    expect(matched[0].normalized).toBe('Add schema file');
  });

  it('matches case-insensitively', () => {
    const matched = matchTasks(headings, ['add schema file']);
    expect(matched.length).toBe(1);
  });

  it('matches with numbering prefix', () => {
    const matched = matchTasks(headings, ['3. Wire up handler']);
    expect(matched.length).toBe(1);
    expect(matched[0].normalized).toBe('Wire up handler');
  });

  it('matches with full heading prefix', () => {
    const matched = matchTasks(headings, ['### 1. Add schema file']);
    expect(matched.length).toBe(1);
  });

  it('phase selector returns all children', () => {
    const matched = matchTasks(headings, ['Phase 1: Core Setup']);
    expect(matched.length).toBe(2);
    expect(matched.map(m => m.normalized)).toEqual(['Add schema file', 'Write unit tests']);
  });

  // The `Phase: Task` fallback branch. A test with this name used to select the bare title
  // `'Wire up handler'`, which resolves on the exact-match path and never reaches the fallback —
  // so the branch shipped untested. It is only reachable when the bare title does NOT match
  // exactly, which in practice means one title repeated under two phases.
  describe('fully-qualified "Phase: Task" selector', () => {
    const DUPLICATE_TITLE_PLAN = `# Plan

## Setup

### 1. Add validation

## Integration

### 2. Add validation
`;
    const dupHeadings = parsePlanHeadings(DUPLICATE_TITLE_PLAN);

    it('disambiguates one title repeated under two phases', () => {
      const setup = matchTasks(dupHeadings, ['Setup: Add validation']);
      expect(setup.length).toBe(1);
      expect(setup[0].parentPhase).toBe('Setup');

      const integration = matchTasks(dupHeadings, ['Integration: Add validation']);
      expect(integration.length).toBe(1);
      expect(integration[0].parentPhase).toBe('Integration');
    });

    it('rejects the bare ambiguous title rather than guessing a phase', () => {
      try {
        matchTasks(dupHeadings, ['Add validation']);
        throw new Error('expected matchTasks to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(MatchError);
        expect((e as MatchError).code).toBe('ambiguous_selector');
      }
    });

    it('cannot qualify a phase whose own name contains ": " — the split takes the FIRST colon', () => {
      // `Phase 2: Integration: Wire up handler` splits into phase `Phase 2` / task
      // `Integration: Wire up handler`, neither of which exists. Pinned because it looks like it
      // should work and silently does not; the workaround is to select the bare title, which is
      // unambiguous whenever the phase name is this specific.
      expect(() => matchTasks(headings, ['Phase 2: Integration: Wire up handler'])).toThrow(MatchError);
      const byTitle = matchTasks(headings, ['Wire up handler']);
      expect(byTitle.length).toBe(1);
      expect(byTitle[0].parentPhase).toBe('Phase 2: Integration');
    });
  });

  it('deduplicates phase + child selectors', () => {
    const matched = matchTasks(headings, ['Phase 1: Core Setup', 'Add schema file']);
    expect(matched.length).toBe(2);
  });

  it('preserves plan order', () => {
    const matched = matchTasks(headings, ['Add validation', 'Add schema file']);
    expect(matched[0].normalized).toBe('Add schema file');
    expect(matched[1].normalized).toBe('Add validation');
  });

  it('throws no_match for unknown selector', () => {
    expect(() => matchTasks(headings, ['Nonexistent task'])).toThrow(MatchError);
    try {
      matchTasks(headings, ['Nonexistent task']);
    } catch (e) {
      expect((e as MatchError).code).toBe('no_match');
    }
  });

  it('recognizes Task N: prefix as numbered heading', () => {
    const plan = `# Plan\n\n## Phase 1\n\n### Task 1: Setup schema\n\n### Task 2: Add tests\n`;
    const h = parsePlanHeadings(plan);
    const numbered = h.filter(x => x.isNumbered);
    expect(numbered.length).toBe(2);
    expect(numbered[0].normalized).toBe('Task 1: Setup schema');
  });

  it('empty selector on Task N: plan returns all tasks', () => {
    const plan = `# Plan\n\n## Phase 1\n\n### Task 1: A\n\n### Task 2: B\n\n## What Doesn't Change\n`;
    const h = parsePlanHeadings(plan);
    const matched = matchTasks(h, []);
    expect(matched.length).toBe(2);
    expect(matched.map(m => m.normalized)).toEqual(['Task 1: A', 'Task 2: B']);
  });

  it('falls back to unnumbered headings when plan has zero numbered tasks', () => {
    const plan = `# My Plan\n\n## Define the types\n\nContent.\n\n## Implement the adapter\n\nMore content.\n\n## Wire it up\n\nFinal.\n`;
    const h = parsePlanHeadings(plan);
    const matched = matchTasks(h, []);
    expect(matched.length).toBe(3);
    expect(matched.map(m => m.normalized)).toEqual(['Define the types', 'Implement the adapter', 'Wire it up']);
  });

  it('excludes structural headings (Problem, Design, etc.) from fallback', () => {
    const plan = `# Plan\n\n## Problem\n\nDesc.\n\n## Design\n\nApproach.\n\n## Create the schema\n\nTask.\n\n## Add tests\n\nTask.\n`;
    const h = parsePlanHeadings(plan);
    const matched = matchTasks(h, []);
    expect(matched.map(m => m.normalized)).toEqual(['Create the schema', 'Add tests']);
  });

  it('skips non-numbered structural headings from empty selection', () => {
    const matched = matchTasks(headings, []);
    const titles = matched.map(m => m.normalized);
    expect(titles).not.toContain("What Doesn't Change");
    expect(titles).not.toContain('Phase 1: Core Setup');
  });

  it('recognizes roman-numeral "Task I-N:" headings as numbered', () => {
    const plan = `# Plan\n\n## Track 1\n\n### Task I-1: Parse the contract\n\n### Task I-12: Materialize acceptance tests\n`;
    const h = parsePlanHeadings(plan);
    const numbered = h.filter(x => x.isNumbered);
    expect(numbered.length).toBe(2);
    expect(numbered.map(x => x.normalized)).toEqual([
      'Task I-1: Parse the contract',
      'Task I-12: Materialize acceptance tests',
    ]);
  });

  it('empty selector on a roman-numeral Task plan returns all Contract Tasks', () => {
    const plan = `# Plan\n\n## Track 1\n\n### Task I-1: A\n\n### Task I-12: B\n\n## What Doesn't Change\n`;
    const h = parsePlanHeadings(plan);
    const matched = matchTasks(h, []);
    expect(matched.length).toBe(2);
    expect(matched.map(m => m.normalized)).toEqual(['Task I-1: A', 'Task I-12: B']);
  });
});
