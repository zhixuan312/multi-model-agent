export interface EvidenceParsed {
  sections: string[];
  text: string;
}

export function extractEvidenceSections(evidence: string): EvidenceParsed {
  if (!evidence) return { sections: [], text: '' };

  const sectionPattern = /\[([^\]]+)\]/g;
  const sections: string[] = [];
  let match;
  while ((match = sectionPattern.exec(evidence)) !== null) {
    sections.push(match[1]);
  }

  const text = evidence.replace(/\[[^\]]+\]\s*/g, '').trim();
  return { sections, text };
}
