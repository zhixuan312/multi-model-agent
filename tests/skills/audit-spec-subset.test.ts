import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('spec audit prompt: partial-spec aware', () => {
  const content = readFileSync('packages/core/src/skills/audit/implement-spec.md', 'utf8');

  it('defines presence in terms of canonical top-level headings', () => {
    expect(content).toContain('present" if and only if the document contains a top-level `## <label>` heading');
    expect(content).toContain('scope solely from the set of canonical `##` headings');
  });

  it('forbids findings based solely on omitted top-level components', () => {
    expect(content).toContain('must not emit a finding solely because a canonical top-level component is absent');
    expect(content).toContain('partial spec');
  });
});
