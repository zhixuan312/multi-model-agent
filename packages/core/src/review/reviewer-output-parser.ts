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
    // Lenient parse: a missing `## Summary` section used to throw and crash
    // the entire run with `runner_crash`. Reviewer models that don't follow
    // the format strictly (some reasoning models freelance the response
    // shape) would take the whole task down. Treat malformed output as
    // `changes_required` with a meta-concern surfacing the format failure
    // so the rework loop can re-prompt instead of crashing.
    const summary = extractSummarySection(text);
    const concerns = extractDeviationsAndUnresolved(text);
    if (!summary) {
      return {
        verdict: 'changes_required',
        concerns: [
          'reviewer output missing `## Summary` section — defaulting verdict to changes_required',
          ...concerns,
        ],
      };
    }
    const lower = summary.toLowerCase();
    const verdict: ReviewerVerdict = lower.includes('changes_required') ? 'changes_required' : 'approved';
    return { verdict, concerns };
  }

  parseDiff(text: string): ReviewerDiffParseResult {
    // Same leniency for diff review: missing verdict marker → concerns
    // (default conservative) plus a meta-concern. Don't crash the run.
    const verdict = extractDiffVerdict(text);
    const concerns = extractDeviationsAndUnresolved(text);
    if (!verdict) {
      return {
        verdict: 'concerns',
        concerns: [
          'diff reviewer output missing APPROVE / CONCERNS: / REJECT: marker — defaulting verdict to concerns',
          ...concerns,
        ],
      };
    }
    return { verdict, concerns };
  }
}

export class ReviewerParseError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewerParseError'; }
}
