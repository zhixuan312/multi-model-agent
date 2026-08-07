import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const reviewerFiles = [
  'packages/core/src/skills/investigate/review.md',
  'packages/core/src/skills/audit/review.md',
  'packages/core/src/skills/research/review.md',
  'packages/core/src/skills/review/review.md',
  'packages/core/src/skills/debug/review.md',
  'packages/core/src/skills/journal_recall/review.md',
  'packages/core/src/skills/journal_record/review.md',
];
const approved = "Don't rephrase text that is already correct and already follows the writing style above.";

describe('reviewer writing-style wording', () => {
  it('uses the approved guard exactly once in every affected reviewer skill and removes legacy prohibitions', async () => {
    for (const path of reviewerFiles) {
      const source = await readFile(path, 'utf8');
      expect(source.split(approved).length - 1, path).toBe(1);
      expect(source, path).not.toContain("Don't rephrase correct text for style.");
      expect(source, path).not.toContain("Don't rephrase for style.");
      expect(source, path).not.toContain("Don't rephrase correct findings for style.");
    }
  });
});