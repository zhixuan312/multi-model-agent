const WHITESPACE_OR_ZW_RE = /[\s\u200B\u200C\u200D\uFEFF]+/gu;
const ASCII_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeHeadlineQuestion(raw: string): string {
  let s = raw.replace(WHITESPACE_OR_ZW_RE, ' ');
  s = s.replace(ASCII_CONTROL_RE, '');
  s = s.trim();
  const codepoints = Array.from(s);
  if (codepoints.length > 60) {
    s = codepoints.slice(0, 60).join('') + '\u2026';
  }
  s = s.replace(/"/g, '\\"');
  return s;
}

export interface InvestigateHeadlineInput {
  question: string;
  workerStatus: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked';
  citationCount: number;
  confidenceLevel: 'high' | 'medium' | 'low' | null;
  unresolvedCount: number;
  incompleteReason?: 'turn_cap' | 'cost_cap' | 'timeout' | 'missing_sections';
}

export function composeInvestigateTerminalHeadline(input: InvestigateHeadlineInput): string {
  const q = normalizeHeadlineQuestion(input.question);
  const conf = input.confidenceLevel ?? 'unparseable';
  if (input.workerStatus === 'done_with_concerns') {
    const reason = input.incompleteReason ?? 'missing_sections';
    return `Investigation: "${q}" \u2014 done with concerns (${reason}), ${input.citationCount} citations so far, ${input.unresolvedCount} unresolved.`;
  }
  if (input.workerStatus === 'needs_context') {
    return `Investigation: "${q}" \u2014 needs context, ${input.unresolvedCount} unresolved.`;
  }
  if (input.workerStatus === 'blocked') {
    return `Investigation: "${q}" \u2014 blocked.`;
  }
  return `Investigation: "${q}" \u2014 ${input.citationCount} citations, confidence ${conf}, ${input.unresolvedCount} unresolved.`;
}
