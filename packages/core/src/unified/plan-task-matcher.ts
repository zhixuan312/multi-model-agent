export interface PlanHeading {
  raw: string;
  normalized: string;
  level: number;
  isNumbered: boolean;
  parentPhase: string | null;
  lineIndex: number;
}

export function normalizeHeading(raw: string): string {
  return raw
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^\d+(?:[\.\)\-]|\s-)\s*/, '')
    .trim();
}

export function parsePlanHeadings(planContent: string): PlanHeading[] {
  const lines = planContent.split('\n');
  const headings: PlanHeading[] = [];
  const phaseStack: Array<{ level: number; normalized: string }> = [];
  let inFencedBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) { inFencedBlock = !inFencedBlock; continue; }
    if (inFencedBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;

    const level = match[1].length;
    const body = match[2].trim();
    const normalized = normalizeHeading(line);
    const strippedBody = body.replace(/^(?:Task\s+)?\d+(?:[\.\)\-:]|\s-)\s*/i, '').trim();
    const isNumbered = strippedBody !== body;

    while (phaseStack.length > 0 && phaseStack[phaseStack.length - 1].level >= level) {
      phaseStack.pop();
    }

    const parentPhase = phaseStack.length > 0
      ? phaseStack[phaseStack.length - 1].normalized
      : null;

    headings.push({ raw: line.trim(), normalized, level, isNumbered, parentPhase, lineIndex: i });

    if (!isNumbered) {
      phaseStack.push({ level, normalized });
    }
  }

  return headings;
}

export class MatchError extends Error {
  code: 'no_match' | 'ambiguous_selector';
  selector: string;
  matches?: string[];

  constructor(code: 'no_match' | 'ambiguous_selector', selector: string, matches?: string[]) {
    const msg = code === 'no_match'
      ? `No heading matches selector: "${selector}"`
      : `Selector "${selector}" matches multiple headings: ${matches!.join(', ')}`;
    super(msg);
    this.code = code;
    this.selector = selector;
    this.matches = matches;
  }
}

const STRUCTURAL_HEADINGS = new Set([
  'problem', 'design', 'overview', 'architecture', 'tech stack',
  'file structure', 'files to change', 'tests', 'test additions',
  'what doesn\'t change', 'further reading',
  'known limitations', 'implementation plan', 'references',
]);

function isStructuralHeading(h: PlanHeading): boolean {
  if (h.level === 1) return true;
  return STRUCTURAL_HEADINGS.has(h.normalized.toLowerCase());
}

export function matchTasks(headings: PlanHeading[], selectors: string[]): PlanHeading[] {
  if (selectors.length === 0) {
    const numbered = headings.filter(h => h.isNumbered);
    if (numbered.length > 0) return numbered;
    return headings.filter(h => !isStructuralHeading(h));
  }

  const matchedSet = new Set<number>();
  const result: PlanHeading[] = [];

  for (const sel of selectors) {
    const norm = normalizeHeading(sel);
    let matches = headings.filter(h => h.normalized.toLowerCase() === norm.toLowerCase());

    if (matches.length === 0) {
      const colonIdx = sel.indexOf(': ');
      if (colonIdx !== -1) {
        const phaseSel = normalizeHeading(sel.substring(0, colonIdx));
        const taskSel = normalizeHeading(sel.substring(colonIdx + 2));
        matches = headings.filter(h =>
          h.parentPhase !== null &&
          h.parentPhase.toLowerCase() === phaseSel.toLowerCase() &&
          h.normalized.toLowerCase() === taskSel.toLowerCase(),
        );
      }
    }

    if (matches.length === 0) {
      throw new MatchError('no_match', sel);
    }

    if (matches.length === 1 && !matches[0].isNumbered) {
      const phase = matches[0];
      const children = headings.filter(h =>
        h.isNumbered && h.parentPhase?.toLowerCase() === phase.normalized.toLowerCase(),
      );
      for (const c of children) {
        if (!matchedSet.has(c.lineIndex)) {
          matchedSet.add(c.lineIndex);
          result.push(c);
        }
      }
      continue;
    }

    if (matches.length > 1) {
      throw new MatchError('ambiguous_selector', sel, matches.map(m => m.raw));
    }

    const m = matches[0];
    if (!matchedSet.has(m.lineIndex)) {
      matchedSet.add(m.lineIndex);
      result.push(m);
    }
  }

  result.sort((a, b) => a.lineIndex - b.lineIndex);
  return result;
}
