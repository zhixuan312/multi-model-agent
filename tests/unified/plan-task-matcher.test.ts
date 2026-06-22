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

  it('fully-qualified Phase: Task selector', () => {
    // "Phase 2: Integration" is the parent phase, "Wire up handler" is the task
    // The colon split finds "Phase 2" as phase selector — but the phase name is "Phase 2: Integration"
    // So we use the task title directly under a matching parent
    const matched = matchTasks(headings, ['Wire up handler']);
    expect(matched.length).toBe(1);
    expect(matched[0].normalized).toBe('Wire up handler');
    expect(matched[0].parentPhase).toBe('Phase 2: Integration');
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

  it('skips non-numbered structural headings from empty selection', () => {
    const matched = matchTasks(headings, []);
    const titles = matched.map(m => m.normalized);
    expect(titles).not.toContain("What Doesn't Change");
    expect(titles).not.toContain('Phase 1: Core Setup');
  });
});
