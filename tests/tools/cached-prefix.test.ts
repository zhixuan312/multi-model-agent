import { describe, it, expect } from 'vitest';
import { buildReadOnlyCachedPrefix, buildReadOnlyCriterionSuffix, type RouteSemantics } from '../../packages/core/src/tools/parallel-criteria-prompt.js';
import { AUDIT_CRITERIA, AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_AUDIT, SCOPE_RULE_AUDIT, ANNOTATOR_AWARENESS_AUDIT } from '../../packages/core/src/tools/audit/implementer-criteria.js';

const STUB_FORMAT = 'Output format: ## Finding N: <title>...';

const AUDIT_SEMANTICS: RouteSemantics = {
  goalLine: 'Find ALL issues of THIS specific kind in the artifact above.',
  emptyOutcomeLine: 'If none exist, respond with "No findings for this criterion."',
  findingMeaningParagraph: 'A finding is an ISSUE in the artifact.',
  severityMeanings: {
    critical: 'blocks execution / data loss',
    high: 'real bug, blocks release',
    medium: 'real issue, fix soon',
    low: 'minor / cosmetic',
  },
};

const baseBlocks = {
  orientation: AUDIT_PURPOSE_ORIENTATION,
  evidenceRule: EVIDENCE_RULE_AUDIT,
  scopeRule: SCOPE_RULE_AUDIT,
  annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
  findingFormat: STUB_FORMAT,
  criteria: AUDIT_CRITERIA,
  semantics: AUDIT_SEMANTICS,
};

describe('buildReadOnlyCachedPrefix (audit)', () => {
  it('lists all 11 audit criteria in the reference taxonomy block', () => {
    const prefix = buildReadOnlyCachedPrefix(baseBlocks, { document: 'Some target doc' });
    AUDIT_CRITERIA.forEach((c) => {
      expect(prefix).toContain(`Criterion ${c.id} — ${c.title}`);
    });
    expect(prefix).toContain('Some target doc');
  });

  it('does NOT include any per-criterion assignment text (the suffix is variable)', () => {
    const prefix = buildReadOnlyCachedPrefix(baseBlocks, { document: 'doc' });
    expect(prefix).not.toContain('Your assignment: criterion');
  });

  it('does NOT include the THOROUGHNESS_REMINDER pressure (no "0–2 findings is unusual" line)', () => {
    const prefix = buildReadOnlyCachedPrefix(baseBlocks, { document: 'doc' });
    expect(prefix).not.toContain('zero or 1-2 findings is unusual');
    expect(prefix).not.toContain('Principle-mapping pass (REQUIRED');
  });

  it('inlines pre-read file contents under "Target files" header', () => {
    const prefix = buildReadOnlyCachedPrefix(baseBlocks, {
      filePaths: ['/tmp/a.md', '/tmp/missing.md'],
      preReadFiles: { '/tmp/a.md': 'CONTENTS OF A' },
    });
    expect(prefix).toContain('--- /tmp/a.md ---');
    expect(prefix).toContain('CONTENTS OF A');
    expect(prefix).toContain('--- /tmp/missing.md ---');
    expect(prefix).toContain('not pre-read');
  });

  it('renders route-specific severity ladder (audit meanings)', () => {
    const prefix = buildReadOnlyCachedPrefix(baseBlocks, { document: 'doc' });
    expect(prefix).toContain('blocks execution / data loss');
    expect(prefix).toContain('real bug, blocks release');
    expect(prefix).toContain('What a "finding" means on this route');
    expect(prefix).toContain('A finding is an ISSUE in the artifact');
  });
});

describe('buildReadOnlyCriterionSuffix', () => {
  it('contains exactly one assignment, the criterion title, and route-specific goal line', () => {
    const suffix = buildReadOnlyCriterionSuffix(AUDIT_SEMANTICS, AUDIT_CRITERIA[0]);
    expect(suffix).toContain(`Your assignment: criterion ${AUDIT_CRITERIA[0].id}`);
    expect(suffix).toContain(AUDIT_CRITERIA[0].title);
    expect(suffix).toContain('No findings for this criterion.');
    expect(suffix).toContain('Find ALL issues of THIS specific kind');
    expect(suffix.length).toBeLessThan(3000);
    expect(suffix).toMatch(/Do NOT drift outside/i);
  });

  it('routes with different semantics produce different goal lines', () => {
    const investigateSemantics: RouteSemantics = {
      goalLine: 'Answer the user\'s question above. Each finding is a CANDIDATE ANSWER.',
      emptyOutcomeLine: 'If you can produce no candidate answer, respond with "No findings for this criterion."',
      findingMeaningParagraph: 'A finding is a CANDIDATE ANSWER.',
      severityMeanings: {
        critical: 'THE answer with high confidence',
        high: 'strong answer',
        medium: 'likely answer / partial',
        low: 'possible candidate',
      },
    };
    const suffix = buildReadOnlyCriterionSuffix(investigateSemantics, AUDIT_CRITERIA[0]);
    expect(suffix).toContain('CANDIDATE ANSWER');
    expect(suffix).not.toContain('Find ALL issues of THIS specific kind');
  });
});
