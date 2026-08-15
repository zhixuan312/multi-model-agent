/**
 * The recall worker must be told where `nodePath` actually resolves.
 *
 * `nodePath` is `record.path` from the journal engine, documented in `engine/types.ts` as
 * "adapter-relative source path (relative to the corpus root)", and the corpus root is set by the
 * recall preprocessor to `<cwd>/.mma/journal`. Stored values look like
 * `nodes/0003-close-caller-facing-enums-at-the-http-boundary.md`.
 *
 * The prompt said "open that candidate's `nodePath` and read the node". The worker runs in `cwd`,
 * so the bare value resolves to `<cwd>/nodes/0003-….md` — which does not exist. Every depth read
 * failed, and the same file forbids the only recovery ("listing, globbing, or scanning
 * `.mma/journal/` is not [expected]"), so the worker was left with the 240-character snippet the
 * depth-read instruction exists to escape.
 *
 * Pinned two ways: the prompt must state the join, and the join it states must be the one the
 * preprocessor uses.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const IMPLEMENT = 'packages/core/src/skills/journal_recall/implement.md';
const PREPROCESSOR = 'packages/server/src/application/preprocessors/journal-recall.ts';

describe('journal_recall tells the worker how to resolve nodePath', () => {
  const prompt = readFileSync(IMPLEMENT, 'utf8');

  it('states the journal-root join wherever it tells the worker to open a node', () => {
    // Every instruction to READ a node must carry the prefix; a bare `nodePath` open is the bug.
    expect(prompt).toContain('.mma/journal/<nodePath>');
    expect(
      prompt,
      'the prompt must say nodePath is relative to the journal root, not the working directory',
    ).toMatch(/relative to the JOURNAL ROOT/i);
  });

  it('the prefix it states is the corpus root the preprocessor actually opens', () => {
    // If the preprocessor ever moves the corpus, the prompt's hardcoded prefix goes stale and
    // depth reads break again — silently, because a failed Read just costs a turn.
    const preprocessor = readFileSync(PREPROCESSOR, 'utf8');
    expect(preprocessor, 'the recall corpus root moved — update the prompt prefix too')
      .toMatch(/'\.mma',\s*'journal'/);
  });

  it('still forbids scanning the corpus, which is what made the broken read unrecoverable', () => {
    expect(prompt).toMatch(/never list, glob, or scan the journal directory/i);
  });
});
