import { describe, it, expect } from 'vitest';
import {
  WARM_FOLLOWUP_PREAMBLE,
  buildWarmFollowupMessage,
} from '../../packages/core/src/lifecycle/warm-followup.js';

describe('WARM_FOLLOWUP_PREAMBLE', () => {
  it('contains the four anchor phrases verbatim', () => {
    // These four substrings MUST appear verbatim in the preamble.
    // They are also the spec's textual contract — changing any of them
    // requires updating the spec doc.
    expect(WARM_FOLLOWUP_PREAMBLE).toContain('already loaded in this thread');
    expect(WARM_FOLLOWUP_PREAMBLE).toContain(
      'Use them directly to answer the new instruction below',
    );
    expect(WARM_FOLLOWUP_PREAMBLE).toContain('Do not re-grep, re-read, or re-discover');
    expect(WARM_FOLLOWUP_PREAMBLE).toContain('Only fetch a new source');
  });

  it('matches the snapshot (full preamble text)', () => {
    expect(WARM_FOLLOWUP_PREAMBLE).toMatchInlineSnapshot(
      `"Context for this task is already loaded in this thread — the brief, prior outputs, file contents you've read, and earlier tool results. Use them directly to answer the new instruction below. Do not re-grep, re-read, or re-discover material already in this conversation. Only fetch a new source if the new instruction names one you haven't yet loaded."`,
    );
  });
});

describe('buildWarmFollowupMessage', () => {
  it('prepends the preamble and a blank-line separator to the instruction body', () => {
    expect(buildWarmFollowupMessage('foo')).toBe(`${WARM_FOLLOWUP_PREAMBLE}\n\nfoo`);
  });

  it('does not mutate an empty instruction body', () => {
    expect(buildWarmFollowupMessage('')).toBe(`${WARM_FOLLOWUP_PREAMBLE}\n\n`);
  });

  it('preserves multi-line instruction bodies verbatim', () => {
    const body = 'line one\nline two\n\nparagraph two';
    expect(buildWarmFollowupMessage(body)).toBe(`${WARM_FOLLOWUP_PREAMBLE}\n\n${body}`);
  });
});
