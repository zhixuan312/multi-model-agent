import type { AnnotatorOutput } from './annotator-engine.js';

export class AnnotatorOutputParser {
  parse(text: string): AnnotatorOutput {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) return { verdict: 'error', findings: [] };
    const obj = JSON.parse(m[1]);
    return { verdict: 'annotated', findings: obj.findings ?? [] };
  }
}
