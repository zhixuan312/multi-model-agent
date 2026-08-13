import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, loadMethodGuidance } from '../../packages/core/src/initiative-record/index.js';
// The seam is deliberately imported from the MODULE, not the barrel — the barrel must not export it.
import { resolveGuidanceFromRootForTest } from '../../packages/core/src/initiative-record/method-guidance.js';

const required: Record<string, string[]> = {
  'software-change@1': ['Caller tracing', 'Error-path review', 'Security-sink review', 'Schema conformance', 'Test adequacy'],
  'research@1': ['Source relevance', 'Claim support', 'Limitation disclosure'],
  'solution-design@1': ['Goal coverage', 'Constraint fit', 'Decision traceability'],
  'architecture-review@1': ['Evidence-backed findings', 'Trade-off analysis', 'Scope coverage'],
  'workflow-design@1': ['Step completeness', 'Role clarity', 'Failure handling'],
  'source-validation@1': ['Provenance', 'Relevance', 'Currency', 'Integrity'],
  'risk-analysis@1': ['Risk coverage', 'Evidence basis', 'Mitigation ownership'],
  'technical-writing@1': ['Accuracy', 'Audience fit', 'Structural completeness'],
  'regulatory-assessment@1': ['Requirement coverage', 'Source currency', 'Professional sign-off when required'],
};

// A section title cannot be satisfied by ANY imperative sentence — it must be an imperative
// sentence actually ABOUT what the title names. Keyed by the exact section title (unique across
// every Method), each pattern matches a stem of one of the title's own significant (>=4 char)
// words, so "Caller tracing" cannot be satisfied by a sentence about, say, schema conformance.
const sectionKeyword: Record<string, RegExp> = {
  'Caller tracing': /\bcaller|\btrac/i,
  'Error-path review': /\berror\b/i,
  'Security-sink review': /\bsink\b/i,
  'Schema conformance': /\bschema\b/i,
  'Test adequacy': /\btest/i,
  'Source relevance': /\bsource\b/i,
  'Claim support': /\bclaim/i,
  'Limitation disclosure': /\blimitation/i,
  'Goal coverage': /\bgoal/i,
  'Constraint fit': /\bconstraint/i,
  'Decision traceability': /\bdecision\b/i,
  'Evidence-backed findings': /\bevidence\b|\bfind/i,
  'Trade-off analysis': /\btrade\b/i,
  'Scope coverage': /\bscope\b/i,
  'Step completeness': /\bstep\b/i,
  'Role clarity': /\brole\b|\bclar/i,
  'Failure handling': /\bfail/i,
  'Provenance': /\bprovenance\b/i,
  'Relevance': /\brelevance\b/i,
  'Currency': /\bcurrency\b/i,
  'Integrity': /\bintegrity\b/i,
  'Risk coverage': /\brisk/i,
  'Evidence basis': /\bevidence\b/i,
  'Mitigation ownership': /\bmitigation\b|\bowner/i,
  'Accuracy': /\baccuracy\b/i,
  'Audience fit': /\baudience\b/i,
  'Structural completeness': /\bstructur/i,
  'Requirement coverage': /\brequirement/i,
  'Source currency': /\bsource\b|\bcurren/i,
  'Professional sign-off when required': /\bprofessional\b|\bsign-off\b/i,
};

describe('Method guidance assets', () => {
  it('has an exact seed-to-production-asset bijection with substantive required sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-method-guidance-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const ids = (store.listMethods() as Array<{ id: string }>).map((method) => method.id).sort();
      store.close();
      expect(ids).toEqual(Object.keys(required).sort());
      const root = resolve(import.meta.dirname, '../..');
      const files = Object.keys(required).map((id) => join(root, 'packages/core/src/methods', id.split('@')[0]!, 'guidance.md'));
      expect(files.every(existsSync)).toBe(true);
      expect(files).toHaveLength(new Set(files).size);
      for (const [id, sections] of Object.entries(required)) {
        const text = loadMethodGuidance(id);
        for (const section of sections) {
          // End-of-input is `(?![\s\S])` — JavaScript has no `\z`, which would match a literal "z".
          const body = text.match(new RegExp(`^#{1,6} ${section}\\s*\\n([\\s\\S]*?)(?=^#{1,6} |(?![\\s\\S]))`, 'mi'))?.[1] ?? '';
          // The verb must OPEN the sentence (not merely appear before its terminator), and that
          // same sentence must carry a keyword drawn from the section's own name — otherwise a
          // generic imperative unrelated to the section's topic would satisfy it.
          // A section must carry a real instruction. Two accepted forms, so the check keeps its
          // bite without pinning prose to one approved opener: an IMPERATIVE opener drawn from a
          // deliberately broad instruction-verb set, or a MODAL construction ("a reviewer must
          // confirm…", "sources should be checked…"). Descriptive prose ("This section covers
          // caller tracing.") still fails, which is the point.
          const IMPERATIVE = 'Use|Check|Trace|Validate|Review|Confirm|Record|Identify|Assess|Define|Compare|Document|State|Ensure|Verify|List|Name|Read|Run|Capture|Report|Prefer|Avoid|Reject|Resolve|Establish|Determine|Cite|Quote|Inspect|Measure|Flag|Treat|Start|Stop';
          const sentence = body.match(
            new RegExp(`^\\s*(?:(?:${IMPERATIVE})\\b[^.!?]*|[^.!?]*\\b(?:must|should|never|always)\\s+(?:be\\s+)?[a-z]+ed?\\b[^.!?]*)[.!?]`, 'm'),
          )?.[0];
          expect(sentence, `${id} § ${section}: no sentence opens with a required verb`).toBeTruthy();
          const keyword = sectionKeyword[section];
          expect(keyword, `no keyword pattern registered for section "${section}"`).toBeTruthy();
          expect(sentence, `${id} § ${section}: instruction sentence does not reference "${section}"`).toMatch(keyword);
        }
      }
      // No-fallback-read proof. NEVER mutate a real committed asset to prove this: the suite
      // runs a fork pool, so renaming `packages/core/src/methods/software-change/guidance.md`
      // races every other test that reads it. Use the INTERNAL, non-exported resolver seam
      // instead — an injectable root that exists only for this test and is not reachable from
      // the public `loadMethodGuidance` signature. Point it at an empty throwaway directory and
      // confirm the resolver throws rather than falling back to any other path.
      expect(() => resolveGuidanceFromRootForTest('software-change@1', join(dir, 'empty-root'))).toThrow(/guidance/i);
      expect(() => loadMethodGuidance('missing@1')).toThrow(/unknown_method|guidance/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});