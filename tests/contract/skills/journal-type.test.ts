import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CATEGORIES = ['decision', 'design', 'behavior', 'process', 'knowledge', 'style'] as const;

describe('contract: journal type vocabulary', () => {
  // The canonical journal `schema.md` is a design/reference doc that lives in the parent
  // workspace's shared `.mma/journal/` tree (gitignored, migrated 2026-07-20) — it is NOT
  // part of this child repo's committed, shippable source. So this contract test anchors the
  // journal type vocabulary + topic/index format against the COMMITTED skill files and handler
  // below, which are the surfaces that actually ship. (Each assertion previously made against
  // schema.md is already duplicated against implement.md, review.md, SKILL.md, or the handler.)
  const implPath = resolve('packages/core/src/skills/journal_record/implement.md');
  const reviewPath = resolve('packages/core/src/skills/journal_record/review.md');
  const recallPath = resolve('packages/core/src/skills/journal_recall/implement.md');
  const recallReviewPath = resolve('packages/core/src/skills/journal_recall/review.md');
  const skillPath = resolve('packages/server/src/skills/mma-journal-record/SKILL.md');
  const handlerPath = resolve('packages/server/src/http/handlers/unified-task.ts');

  const impl = readFileSync(implPath, 'utf8');
  const review = readFileSync(reviewPath, 'utf8');
  const recall = readFileSync(recallPath, 'utf8');
  const recallReview = readFileSync(recallReviewPath, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const handler = readFileSync(handlerPath, 'utf8');

  it('implement.md references type and topic in frontmatter spec', () => {
    expect(impl).toContain('`type`');
    expect(impl).toContain('`topic`');
    expect(impl).toContain('caller supplied structured `topic`');
    expect(impl).toContain('records');
    expect(impl).toContain('legacy single-record');
    // Decide-then-apply: the implementer emits one decision per record instead of
    // writing files; deterministic code applies the batch and computes recorded/failed.
    expect(impl).toContain('emit a structured per-record decision');
    expect(impl).toContain('candidatesByRecord');
    expect(impl).toContain('Emit exactly one decision per submitted record');
  });

  it('implement.md has type classification table', () => {
    for (const cat of CATEGORIES) {
      expect(impl, `implement.md missing type row: ${cat}`).toContain(`\`${cat}\``);
    }
  });

  it('implement.md defines topic inference and emits topic in the decision', () => {
    expect(impl).toContain('lowercase-kebab');
    expect(impl).toContain('EXACT slug equality');
    // The implementer no longer renders index.md itself (deterministic code owns the
    // catalog now); it emits topic as a field of each per-record decision.
    expect(impl).toContain('"topic":');
    expect(impl).toContain('"decision":');
  });

  it('review.md validates type field against the applied result', () => {
    expect(review).toContain('type');
    for (const cat of CATEGORIES) {
      expect(review, `review.md missing type: ${cat}`).toContain(cat);
    }
    // Decide-then-apply: the reviewer verifies the APPLIED { recorded, failed } result
    // (produced by deterministic code), not raw records[] it must re-write.
    expect(review).toContain('APPLIED');
    expect(review).toContain('recorded');
    expect(review).toContain('failed');
    expect(review).toContain('submitted record');
  });

  it('recall implement.md is type-aware', () => {
    expect(recall).toContain('type');
  });

  it('recall review.md checks type accuracy', () => {
    expect(recallReview).toContain('type');
  });

  it('SKILL.md mentions all 6 knowledge types', () => {
    expect(skill).toContain('decision');
    expect(skill).toContain('design rationale');
    expect(skill).toContain('user behavior');
    expect(skill).toContain('process learning');
    expect(skill).toContain('research finding');
    expect(skill).toContain('style convention');
    expect(skill).toContain('records');
    expect(skill).toContain('legacy single-record');
    expect(skill).toContain('one request');
    expect(skill).toContain('recorded[]');
    expect(skill).toContain('failed[]');
  });

  it('handler goal condition references type classification', () => {
    expect(handler).toContain('type (decision/design/behavior/process/knowledge/style)');
  });

  it('recall output format includes category field in findings', () => {
    expect(recall).toContain('"category"');
  });
});
