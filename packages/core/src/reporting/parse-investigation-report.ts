export interface Citation {
  file: string;
  lines: string;
  claim: string;
}

export interface ParseCitationsResult {
  citations: Citation[];
  malformedCitationLines: number;
}

const LINE_TOKEN_RE = /^(?:[1-9][0-9]*)(?:-[1-9][0-9]*)?$/;
const CITATION_RE = /^(?<file>.+):(?<lines>\d+(?:-\d+)?)\s+(?:—|--)\s+(?<claim>.+)$/;
const BULLET_RE = /^(?:[-*]|\d+[.)])\s+/;

function isValidLineToken(token: string): boolean {
  if (!LINE_TOKEN_RE.test(token)) return false;
  const parts = token.split('-');
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isSafeInteger(n)) return false;
  }
  if (parts.length === 2) {
    const [start, end] = parts.map(Number);
    if (start > end) return false;
  }
  return true;
}

export function parseCitations(rawLines: string[]): ParseCitationsResult {
  const citations: Citation[] = [];
  let malformed = 0;
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(BULLET_RE, '');
    const match = stripped.match(CITATION_RE);
    if (!match || !match.groups) {
      malformed++;
      continue;
    }
    const { file, lines, claim } = match.groups;
    if (!isValidLineToken(lines)) {
      malformed++;
      continue;
    }
    if (!claim || !claim.trim()) {
      malformed++;
      continue;
    }
    citations.push({ file: file.trim(), lines, claim: claim.trim() });
  }
  return { citations, malformedCitationLines: malformed };
}
