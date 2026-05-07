import type { ReviewerVerdict, DiffReviewerVerdict } from './review-types.js';

export interface ReviewerParseResult {
  verdict: ReviewerVerdict;
  concerns: string[];
}

export interface ReviewerDiffParseResult {
  verdict: DiffReviewerVerdict;
  concerns: string[];
}

function extractSummarySection(text: string): string | null {
  const match = text.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  return match ? match[1].trim() : null;
}

function extractDeviationsAndUnresolved(text: string): string[] {
  const concerns: string[] = [];

  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed.concerns)) {
        concerns.push(...parsed.concerns);
      }
    } catch {
      // fall through to markdown sections
    }
  }

  const devMatch = text.match(/##\s*Deviations from brief\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (devMatch) {
    const lines = devMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
    concerns.push(...lines.map(l => l.replace(/^-\s*/, '').trim()));
  }

  const unresMatch = text.match(/##\s*Unresolved\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (unresMatch) {
    const lines = unresMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
    concerns.push(...lines.map(l => l.replace(/^-\s*/, '').trim()));
  }

  return concerns;
}

function extractDiffVerdict(text: string): DiffReviewerVerdict | null {
  const trimmed = text.trim();
  if (/^APPROVE\b/i.test(trimmed)) return 'approve';
  if (/^CONCERNS:/i.test(trimmed)) return 'concerns';
  if (/^REJECT:/i.test(trimmed)) return 'reject';
  return null;
}

export class ReviewerOutputParser {
  parse(text: string): ReviewerParseResult {
    const summary = extractSummarySection(text);
    if (!summary) throw new ReviewerParseError('reviewer output missing ## Summary section');
    const lower = summary.toLowerCase();
    const verdict: ReviewerVerdict = lower.includes('changes_required') ? 'changes_required' : 'approved';
    const concerns = extractDeviationsAndUnresolved(text);
    return { verdict, concerns };
  }

  parseDiff(text: string): ReviewerDiffParseResult {
    const verdict = extractDiffVerdict(text);
    if (!verdict) throw new ReviewerParseError('diff reviewer output missing verdict');
    const concerns = extractDeviationsAndUnresolved(text);
    return { verdict, concerns };
  }
}

export class ReviewerParseError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewerParseError'; }
}
