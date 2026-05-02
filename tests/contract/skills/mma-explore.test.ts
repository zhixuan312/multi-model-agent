import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

describe('mma-explore SKILL.md', () => {
  const raw = readFileSync('packages/server/src/skills/mma-explore/SKILL.md', 'utf8');
  const { data, content } = matter(raw);

  it('has required frontmatter keys', () => {
    expect(data.name).toBe('mma-explore');
    expect(data.description).toMatch(/divergent/i);
    expect(data.description).toMatch(/brainstorm/i);
    expect(data.when_to_use).toBeTruthy();
    expect(data.version).toBeTruthy();
  });

  it('contains required sections', () => {
    for (const section of [
      '## Overview', '## When to Use', '## Endpoint',
      '## Request body', '## Full example',
      '## Per-task report shape', '## Best practices',
      '## Common pitfalls',
    ]) {
      expect(content).toContain(section);
    }
  });

  it('cites superpowers:brainstorming as the next step', () => {
    expect(content).toMatch(/superpowers:brainstorming/);
  });

  it('opens "When to Use" with the output-shape fork before any other content', () => {
    // Spec §3.4 — the disambiguation must be the FIRST content under
    // ## When to Use (before the graphviz block, before any prose) so a
    // caller scanning the section catches the fork without reading further.
    const m = content.match(/## When to Use\s*\n([\s\S]*?)(?=\n## )/);
    expect(m, '## When to Use section missing').toBeTruthy();
    const body = m![1];
    // First non-empty line after the heading must reference output shape
    // and route the convergent case to mma-investigate.
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    expect(firstLine).toMatch(/output shape/i);
    expect(body).toMatch(/mma-investigate/);
    expect(body).toMatch(/one\b.*answer|single.*answer/i);
    expect(body).toMatch(/multiple\b.*direction|3.?5 threads/i);
    // Body must mention that internal-vs-external is not the caller's choice.
    expect(body).toMatch(/always runs both|not your decision/i);
  });
});
