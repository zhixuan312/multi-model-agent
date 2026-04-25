import { composeInvestigateTerminalHeadline, normalizeHeadlineQuestion } from '../../packages/core/src/reporting/compose-investigate-headline.js';

describe('normalizeHeadlineQuestion', () => {
  it('collapses runs of whitespace including newlines and NBSP into single spaces', () => {
    expect(normalizeHeadlineQuestion('Where\n  is\t refresh?')).toBe('Where is refresh?');
  });

  it('strips ASCII control characters', () => {
    expect(normalizeHeadlineQuestion('a\x01b\x02c')).toBe('abc');
  });

  it('trims leading and trailing spaces', () => {
    expect(normalizeHeadlineQuestion('   hi   ')).toBe('hi');
  });

  it('truncates by Unicode code points and appends ellipsis', () => {
    const out = normalizeHeadlineQuestion('\u{1F680}'.repeat(70));
    expect(Array.from(out)).toHaveLength(61);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('does not truncate at 60 code points exactly', () => {
    const input = 'a'.repeat(60);
    expect(normalizeHeadlineQuestion(input)).toBe(input);
  });

  it('escapes embedded double quotes', () => {
    expect(normalizeHeadlineQuestion('Where is "refresh"?')).toBe('Where is \\"refresh\\"?');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeHeadlineQuestion('   \n\t  ')).toBe('');
  });
});

describe('composeInvestigateTerminalHeadline', () => {
  it('formats a clean done outcome', () => {
    expect(composeInvestigateTerminalHeadline({
      question: 'How does refresh work?',
      workerStatus: 'done',
      citationCount: 4,
      confidenceLevel: 'high',
      unresolvedCount: 1,
    })).toBe('Investigation: "How does refresh work?" \u2014 4 citations, confidence high, 1 unresolved.');
  });

  it('formats done with zero citations + low confidence', () => {
    expect(composeInvestigateTerminalHeadline({
      question: 'Where is the heartbeat timer cleared?',
      workerStatus: 'done',
      citationCount: 0,
      confidenceLevel: 'low',
      unresolvedCount: 2,
    })).toBe('Investigation: "Where is the heartbeat timer cleared?" \u2014 0 citations, confidence low, 2 unresolved.');
  });

  it('formats done_with_concerns with cap reason', () => {
    expect(composeInvestigateTerminalHeadline({
      question: 'Map the cost-metering module',
      workerStatus: 'done_with_concerns',
      citationCount: 6,
      confidenceLevel: 'medium',
      unresolvedCount: 3,
      incompleteReason: 'turn_cap',
    })).toBe('Investigation: "Map the cost-metering module" \u2014 done with concerns (turn_cap), 6 citations so far, 3 unresolved.');
  });

  it('formats done_with_concerns with missing_sections reason and null confidence', () => {
    const out = composeInvestigateTerminalHeadline({
      question: 'q',
      workerStatus: 'done_with_concerns',
      citationCount: 0,
      confidenceLevel: null,
      unresolvedCount: 0,
      incompleteReason: 'missing_sections',
    });
    expect(out).toContain('done with concerns (missing_sections)');
  });

  it('escapes embedded double quotes in the question', () => {
    const out = composeInvestigateTerminalHeadline({
      question: 'Where is "refresh"?',
      workerStatus: 'done',
      citationCount: 1,
      confidenceLevel: 'high',
      unresolvedCount: 0,
    });
    expect(out).toContain('"Where is \\"refresh\\"?"');
  });

  it('truncates long questions to 60 code points with ellipsis', () => {
    const long = 'a'.repeat(80);
    const out = composeInvestigateTerminalHeadline({
      question: long,
      workerStatus: 'done',
      citationCount: 1,
      confidenceLevel: 'high',
      unresolvedCount: 0,
    });
    expect(out).toContain(`"${'a'.repeat(60)}\u2026"`);
  });

  it('formats needs_context outcome', () => {
    expect(composeInvestigateTerminalHeadline({
      question: 'Which auth flow do you mean?',
      workerStatus: 'needs_context',
      citationCount: 0,
      confidenceLevel: null,
      unresolvedCount: 1,
    })).toBe('Investigation: "Which auth flow do you mean?" \u2014 needs context, 1 unresolved.');
  });

  it('formats blocked outcome', () => {
    expect(composeInvestigateTerminalHeadline({
      question: 'q',
      workerStatus: 'blocked',
      citationCount: 0,
      confidenceLevel: null,
      unresolvedCount: 0,
    })).toBe('Investigation: "q" \u2014 blocked.');
  });
});

describe('normalizeHeadlineQuestion \u2014 zero-width chars', () => {
  it('collapses U+200B (zero-width space) sequences', () => {
    expect(normalizeHeadlineQuestion('a\u200B\u200Bb')).toBe('a b');
  });

  it('collapses NBSP (U+00A0) \u2014 covered by \\s', () => {
    expect(normalizeHeadlineQuestion('a\u00A0b')).toBe('a b');
  });

  it('collapses U+FEFF (BOM) and U+200C/200D', () => {
    expect(normalizeHeadlineQuestion('a\uFEFF\u200Cb\u200Dc')).toBe('a b c');
  });
});
