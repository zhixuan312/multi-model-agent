export interface ParsedReviewReport {
  verdict: 'approved' | 'changes_required';
  deviations: string[];
}

const VERDICT_HEADER = /^##\s*verdict\s*$/im;
const DEVIATIONS_HEADER = /^##\s*deviations\s*$/im;

export function parseReviewReport(text: string): ParsedReviewReport {
  const safe = (text ?? '').toString();
  const verdictMatch = safe.match(VERDICT_HEADER);
  const deviationsMatch = safe.match(DEVIATIONS_HEADER);

  let verdict: 'approved' | 'changes_required' = 'changes_required';
  if (verdictMatch) {
    const after = safe.slice(verdictMatch.index! + verdictMatch[0].length);
    const firstLine = after.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
    if (/approved/i.test(firstLine) && !/changes/i.test(firstLine)) {
      verdict = 'approved';
    }
  } else if (/\bapproved\b/i.test(safe) && !/changes[\s_-]?required/i.test(safe)) {
    verdict = 'approved';
  }

  const deviations: string[] = [];
  if (deviationsMatch) {
    const tail = safe.slice(deviationsMatch.index! + deviationsMatch[0].length);
    const nextHeader = tail.search(/^##\s/im);
    const section = nextHeader === -1 ? tail : tail.slice(0, nextHeader);
    for (const raw of section.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^\(none\)$/i.test(line)) continue;
      const cleaned = line.replace(/^[-*+]\s*/, '').replace(/^\d+\.\s*/, '').trim();
      if (!cleaned) continue;
      deviations.push(cleaned);
    }
  }

  if (verdict === 'approved' && deviations.length > 0) {
    verdict = 'changes_required';
  }

  return { verdict, deviations };
}
