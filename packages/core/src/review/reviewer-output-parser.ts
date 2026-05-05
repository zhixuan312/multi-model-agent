export interface ParsedReviewerVerdict {
  verdict: string;
  concerns: string[];
}

export class ReviewerOutputParser {
  parse(text: string): ParsedReviewerVerdict {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        return { verdict: p.verdict ?? 'approved', concerns: p.concerns ?? [] };
      } catch {
        // fall through to structured fallback
      }
    }
    const lower = text.toLowerCase();
    if (/\bchanges_required\b/.test(lower)) return { verdict: 'changes_required', concerns: [] };
    if (/\bconcerns\b/.test(lower)) return { verdict: 'concerns', concerns: [] };
    return { verdict: 'approved', concerns: [] };
  }

  parseDiff(text: string): { verdict: 'approved' | 'concerns' | 'changes_required' } {
    const trimmed = text.trim();
    if (trimmed === 'APPROVE') return { verdict: 'approved' };
    if (trimmed.startsWith('CONCERNS:')) return { verdict: 'concerns' };
    if (trimmed.startsWith('REJECT:')) return { verdict: 'changes_required' };
    return { verdict: 'concerns' };
  }
}
