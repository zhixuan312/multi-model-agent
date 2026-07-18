import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CATEGORIES = ['decision', 'design', 'behavior', 'process', 'knowledge', 'style'] as const;
const INDEX_HEADER = 'id | timestamp | type | status | title | topic | tags';

describe('contract: journal type vocabulary', () => {
  const schemaPath = resolve('.mma/journal/schema.md');
  const implPath = resolve('packages/core/src/skills/journal_record/implement.md');
  const reviewPath = resolve('packages/core/src/skills/journal_record/review.md');
  const recallPath = resolve('packages/core/src/skills/journal_recall/implement.md');
  const recallReviewPath = resolve('packages/core/src/skills/journal_recall/review.md');
  const skillPath = resolve('packages/server/src/skills/mma-journal-record/SKILL.md');
  const handlerPath = resolve('packages/server/src/http/handlers/unified-task.ts');

  const schema = readFileSync(schemaPath, 'utf8');
  const impl = readFileSync(implPath, 'utf8');
  const review = readFileSync(reviewPath, 'utf8');
  const recall = readFileSync(recallPath, 'utf8');
  const recallReview = readFileSync(recallReviewPath, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const handler = readFileSync(handlerPath, 'utf8');

  it('schema.md defines all 6 types', () => {
    for (const cat of CATEGORIES) {
      expect(schema, `schema.md missing type: ${cat}`).toContain(cat);
    }
  });

  it('schema.md documents topic as a first-class journal field', () => {
    expect(schema).toContain('## Topic');
    expect(schema).toContain('lowercase kebab-case');
    expect(schema).toContain('unscoped');
  });

  it('schema.md index format includes topic column', () => {
    expect(schema).toContain(INDEX_HEADER);
  });

  it('implement.md references type and topic in frontmatter spec', () => {
    expect(impl).toContain('`type`');
    expect(impl).toContain('`topic`');
    expect(impl).toContain('caller supplied structured `topic`');
  });

  it('implement.md has type classification table', () => {
    for (const cat of CATEGORIES) {
      expect(impl, `implement.md missing type row: ${cat}`).toContain(`\`${cat}\``);
    }
  });

  it('implement.md defines topic inference and the new index format', () => {
    expect(impl).toContain('lowercase-kebab');
    expect(impl).toContain('EXACT slug equality');
    expect(impl).toContain(INDEX_HEADER);
    expect(impl).toContain('"topic":');
  });

  it('review.md validates type field', () => {
    expect(review).toContain('type');
    for (const cat of CATEGORIES) {
      expect(review, `review.md missing type: ${cat}`).toContain(cat);
    }
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
  });

  it('handler goal condition references type classification', () => {
    expect(handler).toContain('type (decision/design/behavior/process/knowledge/style)');
  });

  it('recall output format includes category field in findings', () => {
    expect(recall).toContain('"category"');
  });
});
