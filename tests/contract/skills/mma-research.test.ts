import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

describe('mma-research SKILL.md', () => {
  const raw = readFileSync('packages/server/src/skills/mma-research/SKILL.md', 'utf8');
  const { data, content } = matter(raw);

  it('has required frontmatter keys', () => {
    expect(data.name).toBe('mma-research');
    expect(data.description).toMatch(/external/i);
    expect(data.description).toMatch(/citation|research/i);
    expect(data.when_to_use).toBeTruthy();
    expect(data.version).toBeTruthy();
  });

  it('documents the mma_run dispatch and request body', () => {
    expect(content).toContain('mma_run');
    expect(content).toContain('prompt');
  });

  it('documents the mma clients fallback instead of client-specific auth headers', () => {
    expect(content).toContain('mma clients');
  });

  it('includes the shared response-shape guide (poll with mma_task_get / mma_task_wait)', () => {
    expect(content).toMatch(/@include _shared\/response-shape|mma_task_get|mma_task_wait/);
  });

  it('is route-level (not an orchestration playbook)', () => {
    // Sanity: the body should NOT mandate parallel fan-out or synthesis —
    // those belong to mma-explore.
    expect(content).not.toMatch(/in ONE message/);
    expect(content).not.toMatch(/3.?5 threads/);
  });
});
