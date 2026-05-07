import type { AnnotatedFinding } from './review-types.js';

export interface AnnotatorParseResult {
  verdict: 'annotated' | 'error';
  annotatedFindings: AnnotatedFinding[];
  errorReason?: string;
}

function extractFencedJson(text: string): string | null {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  return match ? match[1].trim() : null;
}

export class AnnotatorOutputParser {
  parse(input: { finalAssistantText: string | undefined; errorCode?: string }): AnnotatorParseResult {
    if (!input.finalAssistantText) {
      return { verdict: 'error', annotatedFindings: [], errorReason: input.errorCode ?? 'no output' };
    }
    const json = extractFencedJson(input.finalAssistantText);
    if (!json) return { verdict: 'error', annotatedFindings: [], errorReason: 'no fenced JSON block' };
    try {
      const findings = JSON.parse(json) as AnnotatedFinding[];
      if (!Array.isArray(findings)) return { verdict: 'error', annotatedFindings: [], errorReason: 'expected JSON array' };
      return { verdict: 'annotated', annotatedFindings: findings };
    } catch (e) {
      return { verdict: 'error', annotatedFindings: [], errorReason: `JSON parse failed: ${(e as Error).message}` };
    }
  }
}
