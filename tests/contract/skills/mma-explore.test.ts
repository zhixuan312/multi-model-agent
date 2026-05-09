import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

describe('mma-explore SKILL.md', () => {
  const raw = readFileSync('packages/server/src/skills/mma-explore/SKILL.md', 'utf8');
  const { data, content } = matter(raw);

  it('has required frontmatter keys', () => {
    expect(data.name).toBe('mma-explore');
    expect(data.description).toMatch(/divergent/i);
    expect(data.description).toMatch(/brainstorm|plan/i);
    expect(data.when_to_use).toBeTruthy();
    expect(data.version).toBeTruthy();
  });

  it('contains required sections (skill-template parity)', () => {
    for (const section of [
      '## Overview', '## When to Use', '## How to run',
      '## Per-task report shape', '## Best practices', '## Common pitfalls',
      '## Failure handling',
    ]) {
      expect(content).toContain(section);
    }
  });

  it('mandates parallel fan-out in ONE message', () => {
    expect(content).toContain('in ONE message');
  });

  it('mandates the synthesis output shape (MUST + 3–5 threads)', () => {
    expect(content).toMatch(/MUST[\s\S]{0,80}3.?5 threads/);
  });

  it('contains both sentinel literals for greenfield + research-empty', () => {
    expect(content).toContain('(no internal anchor — fully greenfield)');
    expect(content).toContain('(no external source found)');
  });

  it('mandates the Recommended next step header', () => {
    expect(content).toContain('## Recommended next step');
  });

  it('contains the lazy-main-agent guard', () => {
    expect(content).toMatch(/Do(?:n't| NOT|\snot)\s+dump/i);
  });

  it('references both sub-skills by name (delegates via skill, not raw HTTP)', () => {
    expect(content).toContain('mma-investigate');
    expect(content).toContain('mma-research');
  });
});
