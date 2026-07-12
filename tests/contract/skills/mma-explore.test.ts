import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

describe('mma-explore SKILL.md', () => {
  const raw = readFileSync('packages/server/src/skills/mma-explore/SKILL.md', 'utf8');
  const { data, content } = matter(raw);

  it('has required frontmatter keys', () => {
    expect(data.name).toBe('mma-explore');
    expect(data.description).toMatch(/divergent/i);
    expect(data.description).toMatch(/exploration/i);
    expect(data.when_to_use).toBeTruthy();
    expect(data.version).toBeTruthy();
  });

  it('contains required sections', () => {
    for (const section of [
      '## Overview', '## When to Use', '## The workflow',
      '## exploration.md structure', '## Reading the leg results',
      '## Common pitfalls', '## Failure handling',
    ]) {
      expect(content).toContain(section);
    }
  });

  it('mandates parallel fan-out in ONE message', () => {
    expect(content).toContain('in ONE message');
  });

  it('writes the artifact to .mma/explorations/', () => {
    expect(content).toContain('.mma/explorations/');
  });

  it('exploration.md carries the three Forge-aligned top-level sections', () => {
    expect(content).toContain('## Background');
    expect(content).toContain('## Current State');
    expect(content).toContain('## Rough Direction');
  });

  it('keeps the divergent 3–5 ranked directions inside Rough Direction', () => {
    expect(content).toMatch(/3.?5 ranked candidate directions/);
  });

  it('describes the lightweight (non-per-task) user gate', () => {
    expect(content).toContain("Anything you'd add");
  });

  it('contains the sentinel literals for greenfield + research-empty + journal-empty', () => {
    expect(content).toContain('(no internal anchor — fully greenfield)');
    expect(content).toContain('(no external source found)');
    expect(content).toContain('(no prior learning)');
  });

  it('contains the lazy-main-agent guard', () => {
    expect(content).toMatch(/Do(?:n't| NOT|\snot)\s+dump/i);
  });

  it('references all three sub-skills by name (delegates via skill, not raw HTTP)', () => {
    expect(content).toContain('mma-investigate');
    expect(content).toContain('mma-research');
    expect(content).toContain('mma-journal-recall');
  });

  it('soft-suggests mma-brainstorm as the natural next step', () => {
    expect(content).toContain('mma-brainstorm');
  });

  it('declares the journal leg as a third source in frontmatter + body', () => {
    expect(data.description).toMatch(/journal|prior.learning|recall/i);
    expect(content).toMatch(/ALL THREE|three delegated|three parallel|three legs|all three/i);
  });
});
