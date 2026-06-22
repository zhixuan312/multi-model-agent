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

  it('documents the route and request body', () => {
    expect(content).toContain('POST /task');
    expect(content).toContain('prompt');
  });

  it('documents auth + identity headers', () => {
    expect(content).toContain('Authorization: Bearer');
    expect(content).toContain('X-MMA-Client');
  });

  it('includes the shared polling guide', () => {
    expect(content).toMatch(/@include _shared\/polling|while true|GET \/batch/);
  });

  it('documents auth via @include _shared/auth (project convention)', () => {
    expect(content).toMatch(/@include _shared\/auth|Authorization: Bearer/);
  });

  it('is route-level (not an orchestration playbook)', () => {
    // Sanity: the body should NOT mandate parallel fan-out or synthesis —
    // those belong to mma-explore.
    expect(content).not.toMatch(/in ONE message/);
    expect(content).not.toMatch(/3.?5 threads/);
  });
});
