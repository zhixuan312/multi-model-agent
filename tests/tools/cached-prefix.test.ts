import { describe, it, expect } from 'vitest';
import { buildReadOnlyCachedPrefix, buildReadOnlyCriterionSuffix } from '../../packages/core/src/tools/parallel-criteria-prompt.js';
import { AUDIT_CRITERIA, AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_AUDIT, SCOPE_RULE_AUDIT, ANNOTATOR_AWARENESS_AUDIT } from '../../packages/core/src/tools/audit/implementer-criteria.js';

const STUB_FORMAT = 'Output format: ## Finding N: <title>...';

describe('buildReadOnlyCachedPrefix (audit)', () => {
  it('lists all 11 audit criteria in the reference taxonomy block', () => {
    const prefix = buildReadOnlyCachedPrefix(
      {
        orientation: AUDIT_PURPOSE_ORIENTATION,
        evidenceRule: EVIDENCE_RULE_AUDIT,
        scopeRule: SCOPE_RULE_AUDIT,
        annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
        findingFormat: STUB_FORMAT,
        criteria: AUDIT_CRITERIA,
      },
      { document: 'Some target doc' },
    );
    AUDIT_CRITERIA.forEach((c) => {
      expect(prefix).toContain(`Criterion ${c.id} — ${c.title}`);
    });
    expect(prefix).toContain('Some target doc');
  });

  it('does NOT include any per-criterion assignment text (the suffix is variable)', () => {
    const prefix = buildReadOnlyCachedPrefix(
      {
        orientation: AUDIT_PURPOSE_ORIENTATION,
        evidenceRule: EVIDENCE_RULE_AUDIT,
        scopeRule: SCOPE_RULE_AUDIT,
        annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
        findingFormat: STUB_FORMAT,
        criteria: AUDIT_CRITERIA,
      },
      { document: 'doc' },
    );
    expect(prefix).not.toContain('Your assignment: criterion');
  });

  it('does NOT include the THOROUGHNESS_REMINDER pressure (no "0–2 findings is unusual" line)', () => {
    const prefix = buildReadOnlyCachedPrefix(
      {
        orientation: AUDIT_PURPOSE_ORIENTATION,
        evidenceRule: EVIDENCE_RULE_AUDIT,
        scopeRule: SCOPE_RULE_AUDIT,
        annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
        findingFormat: STUB_FORMAT,
        criteria: AUDIT_CRITERIA,
      },
      { document: 'doc' },
    );
    expect(prefix).not.toContain('zero or 1-2 findings is unusual');
    expect(prefix).not.toContain('Principle-mapping pass (REQUIRED');
  });

  it('inlines pre-read file contents under "Target files" header', () => {
    const prefix = buildReadOnlyCachedPrefix(
      {
        orientation: AUDIT_PURPOSE_ORIENTATION,
        evidenceRule: EVIDENCE_RULE_AUDIT,
        scopeRule: SCOPE_RULE_AUDIT,
        annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
        findingFormat: STUB_FORMAT,
        criteria: AUDIT_CRITERIA,
      },
      {
        filePaths: ['/tmp/a.md', '/tmp/missing.md'],
        preReadFiles: { '/tmp/a.md': 'CONTENTS OF A' },
      },
    );
    expect(prefix).toContain('--- /tmp/a.md ---');
    expect(prefix).toContain('CONTENTS OF A');
    expect(prefix).toContain('--- /tmp/missing.md ---');
    expect(prefix).toContain('not pre-read');
  });
});

describe('buildReadOnlyCriterionSuffix', () => {
  it('contains exactly one assignment, the criterion title, and explicit permission for "No findings"', () => {
    const suffix = buildReadOnlyCriterionSuffix(AUDIT_CRITERIA[0]);
    expect(suffix).toContain(`Your assignment: criterion ${AUDIT_CRITERIA[0].id}`);
    expect(suffix).toContain(AUDIT_CRITERIA[0].title);
    expect(suffix).toContain('No findings for this criterion.');
    expect(suffix.length).toBeLessThan(3000);
    // Should mention the worker not to report outside its criterion
    expect(suffix).toMatch(/Do NOT report findings outside/i);
  });
});
